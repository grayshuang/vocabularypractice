import { useState, useEffect, Component } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api';
import { logout } from '../auth';
import { getDateRange, withinRange, formatDate } from '../utils/dateFilter';
import { modeLabel } from '../modes';

// 错误边界：避免单个学生详情渲染崩溃导致整页白屏
class DashboardErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('RoomDashboard 渲染错误:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-red-600 font-bold text-lg">页面渲染出错</p>
          <pre className="text-xs text-red-500 bg-red-50 rounded p-3 max-w-2xl overflow-auto whitespace-pre-wrap text-left">
            {String(this.state.error && this.state.error.stack || this.state.error)}
          </pre>
          <button onClick={() => this.setState({ error: null })}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm">重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// 秒数 → 友好时长（中文）
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  if (sec < 60) return sec + '秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}分${s}秒` : `${m}分`;
  const h = Math.floor(m / 60);
  return `${h}时${m % 60}分`;
}

export default function RoomDashboard() {
  const { roomCode } = useParams();
  const [room, setRoom] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);     // 当前展开的学生 id
  const [details, setDetails] = useState({});          // { studentId: [sessions] }
  const [loadingDetails, setLoadingDetails] = useState(null); // 正在加载详情的 studentId
  const [exporting, setExporting] = useState(false);
  const navigate = useNavigate();

  // 学生提交日期筛选状态
  const [period, setPeriod] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    try {
      const roomRes = await api.getRoom(roomCode);
      const r = roomRes.data || roomRes;
      setRoom(r);
      const rid = r.id;
      setRoomId(rid);
      if (rid) {
        const stuRes = await api.getRoomStudents(rid);
        setStudents(stuRes.data || stuRes || []);
      }
    } catch (err) {
      setError('加载数据失败');
    } finally {
      setLoading(false);
    }
  }

  async function toggleStudent(stu) {
    const sid = stu.id;
    if (expanded === sid) { setExpanded(null); return; }
    setExpanded(sid);
    if (!details[sid]) {
      setLoadingDetails(sid);
      try {
        const res = await api.getStudentDetails(roomId, sid);
        const arr = (res && Array.isArray(res.data)) ? res.data
          : (Array.isArray(res) ? res : []);
        setDetails(prev => ({ ...prev, [sid]: arr }));
      } catch (e) { console.error('加载学生详情失败', e); }
      finally { setLoadingDetails(null); }
    }
  }

  async function exportCSV() {
    if (filteredStudents.length === 0) return;
    setExporting(true);
    try {
      // 确保所有学生明细都已加载
      const allDetails = { ...details };
      const needFetch = filteredStudents.filter(s => !allDetails[s.id]);
      await Promise.all(needFetch.map(async (s) => {
        const res = await api.getStudentDetails(roomId, s.id);
        allDetails[s.id] = res.data || res || [];
      }));
      setDetails(allDetails);

      const range = getDateRange(period, from, to);

      const header = ['学生姓名', '总正确率%', '练习次数', '总用时', '暂停次数', '词汇', '正误', '学生答案', '正确答案'];
      const rows = [header];
      for (const stu of filteredStudents) {
        const name = stu.name || stu.username;
        const acc = stu.overall_accuracy;
        const allSessions = allDetails[stu.id] || [];
        // 仅保留所选日期范围内的提交
        const sessionsInRange = allSessions.filter(s => withinRange(s.finished_at, range));
        if (sessionsInRange.length === 0) {
          rows.push([name, acc, stu.practice_count, '', '', '(该日期范围内无提交)', '', '', '']);
        } else {
          sessionsInRange.forEach(session => {
            const dur = fmtDur(session.elapsed_time);
            const pc = session.pause_count || 0;
            session.answers.forEach(a => {
              rows.push([
                name, acc, sessionsInRange.length, dur, pc,
                a.word, a.is_correct ? '正确' : '错误',
                a.student_answer || '', a.correct_answer || ''
              ]);
            });
          });
        }
      }
      const csv = '﻿' + rows.map(r => r.map(v => `"${String(v === undefined ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `房间${roomCode}_学生练习明细.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('导出失败：' + (e.message || '未知错误'));
    } finally {
      setExporting(false);
    }
  }

  async function handleDeleteRoom() {
    if (!window.confirm('确定要删除这个房间吗？相关练习数据也会被删除。')) return;
    try {
      await api.deleteRoom(roomCode);
      alert('房间已删除');
      navigate('/teacher');
    } catch (err) {
      setError('删除失败');
    }
  }

  function handleLogout() {
    logout();
    window.location.href = '/teacher';
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center">加载中...</div>;
  if (error) return <div className="min-h-screen flex items-center justify-center text-red-600">{error}</div>;
  if (!room) return <div className="min-h-screen flex items-center justify-center">房间不存在</div>;

  // 按提交日期筛选学生（依据 last_submitted_at）
  const range = getDateRange(period, from, to);
  const filteredStudents = students.filter(s => withinRange(s.last_submitted_at, range));

  return (
    <DashboardErrorBoundary>
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* 顶部导航 */}
      <nav className="bg-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate('/teacher')} className="text-indigo-600 hover:text-indigo-800">← 返回</button>
            <h1 className="text-xl font-bold text-indigo-700">房间 #{roomCode} 统计</h1>
          </div>
          <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800">退出</button>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* 房间信息 */}
        <div className="bg-white rounded-2xl shadow-lg p-6">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-2xl font-bold text-gray-800">房间 #{roomCode}</h2>
              <p className="text-gray-600 mt-1">词汇数：{room.vocabulary_list?.length || 0} | 已加入学生：{students.length} 人</p>
              <div className="flex flex-wrap gap-2 mt-3">
                {(room.vocabulary_list || []).map((w, i) => (
                  <span key={i} className="px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full text-sm">{w}</span>
                ))}
              </div>
              {room.mode_usage && Object.keys(room.mode_usage).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 items-center">
                  <span className="text-xs text-gray-400">模式使用次数：</span>
                  {Object.entries(room.mode_usage).map(([m, c]) => (
                    <span key={m} className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">{modeLabel(m)} · {c}</span>
                  ))}
                </div>
              )}
            </div>
            <button onClick={handleDeleteRoom} className="px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition text-sm">删除房间</button>
          </div>
        </div>

        {/* 学生统计 */}
        <div className="bg-white rounded-2xl shadow-lg p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-xl font-bold text-gray-800">学生练习结果</h3>
            <button onClick={exportCSV} disabled={exporting}
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition text-sm disabled:opacity-50">
              {exporting ? '导出中...' : '⬇ 导出表格 (CSV)'}
            </button>
          </div>

          {/* 提交日期筛选 */}
          <div className="mt-4 p-3 bg-gray-50 rounded-lg space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              {[
                { k: 'all', t: '全部' },
                { k: 'today', t: '今天' },
                { k: 'week', t: '本周' },
                { k: 'month', t: '本月' },
              ].map(p => (
                <button
                  key={p.k}
                  onClick={() => { setPeriod(p.k); if (p.k !== 'custom') { setFrom(''); setTo(''); } }}
                  className={`text-xs px-3 py-1 rounded-full border ${period === p.k ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                >
                  {p.t}
                </button>
              ))}
              <button
                onClick={() => setPeriod('custom')}
                className={`text-xs px-3 py-1 rounded-full border ${period === 'custom' ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`}
              >
                自定义
              </button>
            </div>
            {period === 'custom' && (
              <div className="flex items-center gap-2 flex-wrap">
                <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                  className="text-xs border border-gray-200 rounded px-2 py-1 outline-none" />
                <span className="text-gray-400 text-xs">至</span>
                <input type="date" value={to} onChange={e => setTo(e.target.value)}
                  className="text-xs border border-gray-200 rounded px-2 py-1 outline-none" />
              </div>
            )}
            <p className="text-[11px] text-gray-400">按提交日期筛选：共 {filteredStudents.length} 名学生提交</p>
          </div>

          {students.length === 0 ? (
            <p className="text-gray-500 text-center py-4">暂无学生加入</p>
          ) : filteredStudents.length === 0 ? (
            <p className="text-gray-500 text-center py-4">该日期范围内暂无学生提交</p>
          ) : (
            <div className="space-y-2">
              {filteredStudents.map(stu => {
                const isOpen = expanded === stu.id;
                const d = Array.isArray(details[stu.id]) ? details[stu.id] : [];
                const accColor = stu.overall_accuracy >= 80 ? 'text-green-600' : stu.overall_accuracy >= 60 ? 'text-yellow-600' : 'text-red-600';
                return (
                  <div key={stu.id} className="border border-gray-200 rounded-lg">
                    <button onClick={() => toggleStudent(stu)}
                      className="w-full text-left p-3 flex justify-between items-center hover:bg-gray-50 transition">
                      <div>
                        <span className="font-bold text-gray-800">{stu.name || stu.username}</span>
                        <span className="text-xs text-gray-500 ml-2">{stu.username}</span>
                        {stu.student_type && <span className="text-xs text-gray-400 ml-2">{stu.student_type}{stu.class_code ? `·${stu.class_code}` : ''}</span>}
                        {!stu.submitted
                          ? <span className="ml-2 text-xs px-2 py-0.5 bg-gray-100 text-gray-500 rounded">未提交</span>
                          : <span className="ml-2 text-xs text-gray-400">提交于 {formatDate(stu.last_submitted_at)}</span>}
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className={`text-lg font-bold ${accColor}`}>{stu.overall_accuracy}%</p>
                          <p className="text-xs text-gray-500">总正确 · {stu.practice_count}次</p>
                        </div>
                        <span className="text-gray-400">{isOpen ? '▲' : '▼'}</span>
                      </div>
                    </button>

                    {/* 展开：逐词正误 */}
                    {isOpen && (
                      <div className="bg-gray-50 px-4 py-3 border-t border-gray-200">
                        {loadingDetails === stu.id ? (
                          <p className="text-sm text-gray-400 py-2">加载中…</p>
                        ) : d.length === 0 ? (
                          <p className="text-sm text-gray-500 py-2">该学生尚未提交任何练习。</p>
                        ) : (
                          <div className="space-y-3">
                            {d.map((session, si) => (
                              <div key={session.session_id || si}>
                                <p className="text-xs text-gray-500 mb-1">
                                  第{si + 1}次提交 · {session.finished_at ? new Date(session.finished_at).toLocaleString('zh-CN') : '时间未知'} · 本次正确率 {session.accuracy ?? 0}% · 用时 {fmtDur(session.elapsed_time)} · 暂停 {session.pause_count || 0} 次
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                  {(session.answers || []).map((a, ai) => {
                                    const isUnanswered = a.student_answer === '(未作答)';
                                    return (
                                      <span key={ai}
                                        className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border ${
                                          a.is_correct
                                            ? 'bg-green-50 text-green-700 border-green-200'
                                            : 'bg-red-50 text-red-700 border-red-200'
                                        }`}>
                                        <span className={a.is_correct ? 'text-green-600' : 'text-red-500'}>
                                          {a.is_correct ? '✓' : '✗'}
                                        </span>
                                        <span className="font-semibold">{typeof a.word === 'object' ? (a.word?.word || a.word?.[0] || JSON.stringify(a.word)) : String(a.word || '')}</span>
                                        {isUnanswered && (
                                          <span className="text-gray-400 font-normal">（未作答）</span>
                                        )}
                                        {!a.is_correct && !isUnanswered && a.student_answer && (
                                          <span className="text-red-400 font-normal">（答 {typeof a.student_answer === 'object' ? JSON.stringify(a.student_answer) : a.student_answer}）</span>
                                        )}
                                      </span>
                                    );
                                  })}
                                </div>
                                {/* 正确数汇总 */}
                                {((session.answers || []).length > 0) && (
                                  <p className="text-[10px] text-gray-400 mt-1">
                                    正确 {(session.answers || []).filter(a => a.is_correct).length}/{(session.answers || []).length}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
    </DashboardErrorBoundary>
  );
}
