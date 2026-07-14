import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { isLoggedIn, getUserType, logout, getToken } from '../auth';
import { getDateRange, withinRange, formatDate } from '../utils/dateFilter';

export default function StudentHome() {
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [studentName, setStudentName] = useState('');
  const [joinedRooms, setJoinedRooms] = useState([]);
  // 按加入日期筛选
  const [period, setPeriod] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // 房间备注（草稿 + 保存中状态）
  const [noteInputs, setNoteInputs] = useState({});
  const [savingNoteId, setSavingNoteId] = useState(null);
  // 三点菜单：哪个卡片菜单展开 / 哪个卡片正在编辑备注
  const [openMenuId, setOpenMenuId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoggedIn()) {
      navigate('/student');
      return;
    }
    // 从localStorage读取学生信息
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      setStudentName(user.name || '');
    } catch {}
    loadJoinedRooms();
  }, [navigate]);

  const handleJoin = async (e) => {
    e.preventDefault();
    if (!roomCode.trim()) return setError('请输入房间号');
    setLoading(true);
    setError('');
    try {
      await api.joinRoom(roomCode.trim());
      navigate(`/practice?room_code=${roomCode.trim()}`);
    } catch (err) {
      setError(err.response?.data?.error || '加入房间失败');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    window.location.href = '/student';
  };

  const loadJoinedRooms = async () => {
    try {
      const data = await api.getStudentRooms();
      const list = Array.isArray(data) ? data : [];
      setJoinedRooms(list);
      const init = {};
      list.forEach(r => { init[r.room_id] = r.note || ''; });
      setNoteInputs(init);
    } catch (err) {
      console.error('加载房间列表失败', err);
    }
  };

  const rejoinRoom = (room_code) => {
    navigate('/practice?room_code=' + room_code);
  };

  const saveNote = async (room) => {
    const note = (noteInputs[room.room_id] || '').slice(0, 200);
    setSavingNoteId(room.room_id);
    try {
      await api.saveRoomNote(room.room_code, note);
      setJoinedRooms(prev => prev.map(r => r.room_id === room.room_id ? { ...r, note } : r));
      setEditingId(null);
    } catch (err) {
      console.error('保存备注失败', err);
      alert('备注保存失败：' + (err.message || '未知错误'));
    } finally {
      setSavingNoteId(null);
    }
  };

  const deleteRoom = async (room) => {
    if (!window.confirm(`确定要永久删除房间 #${room.room_code} 吗？\n删除后将从你的房间列表中移除，且无法恢复。`)) return;
    try {
      await api.leaveRoom(room.room_code);
      // 标记该房间下次进入为全新状态（不恢复上次完成记录）
      try { localStorage.setItem('fresh_practice:' + room.room_code, '1'); } catch (_) {}
      setJoinedRooms(prev => prev.filter(r => r.room_id !== room.room_id));
      setOpenMenuId(null);
    } catch (err) {
      console.error('删除房间失败', err);
      alert('删除失败：' + (err.response?.data?.error || err.message || '未知错误'));
    }
  };

  if (!isLoggedIn()) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* 顶部导航 */}
      <nav className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-3 flex justify-between items-center">
          <h1 className="text-xl font-bold text-indigo-700">词汇练习</h1>
          <div className="flex items-center gap-4">
            <span className="text-gray-700">{studentName}，你好！</span>
            <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800">退出</button>
          </div>
        </div>
      </nav>

      {/* 主内容 */}
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-white rounded-2xl shadow-lg p-8 mt-8">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">加入练习</h2>
          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">房间号</label>
              <input
                type="text"
                placeholder="请输入6位房间号"
                value={roomCode}
                onChange={e => setRoomCode(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-lg tracking-widest text-center"
                maxLength={6}
                required
              />
            </div>
            {error && <p className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</p>}
            <button type="submit" disabled={loading} className="w-full py-3 px-4 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition font-medium text-lg disabled:opacity-50">
              {loading ? '加入中...' : '加入房间'}
            </button>
          </form>
        </div>

        {/* 已加入的房间 */}
        {joinedRooms.length > 0 && (() => {
          const range = getDateRange(period, from, to);
          const filteredRooms = joinedRooms.filter(r => withinRange(r.joined_at, range));
          return (
          <div className="bg-white rounded-2xl shadow-lg p-6 mt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xl font-bold text-gray-800">已加入的房间</h2>
              <span className="text-xs text-gray-400">{filteredRooms.length}/{joinedRooms.length}</span>
            </div>

            {/* 按加入日期筛选 */}
            <div className="bg-gray-50 rounded-lg p-3 mb-4 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                {[
                  { k: 'all', t: '全部' },
                  { k: 'today', t: '今天' },
                  { k: 'week', t: '本周' },
                  { k: 'month', t: '本月' },
                ].map(p => (
                  <button key={p.k}
                    onClick={() => { setPeriod(p.k); if (p.k !== 'custom') { setFrom(''); setTo(''); } }}
                    className={`text-xs px-3 py-1 rounded-full border ${period === p.k ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-200 hover:bg-gray-100'}`}>
                    {p.t}
                  </button>
                ))}
                <button onClick={() => setPeriod('custom')}
                  className={`text-xs px-3 py-1 rounded-full border ${period === 'custom' ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 border-gray-200 hover:bg-gray-100'}`}>
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
            </div>

            <div className="space-y-3">
              {filteredRooms.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">该日期范围内暂无加入的房间</p>
              ) :               filteredRooms.map(room => (
                <div key={room.room_id} onClick={() => rejoinRoom(room.room_code)}
                  className="relative border border-gray-200 rounded-lg p-4 hover:border-indigo-300 transition cursor-pointer">
                  <div className="flex items-start justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-bold text-indigo-700">#{room.room_code}</span>
                      {room.note ? (
                        <span className="text-xs text-gray-500">备注：{room.note}</span>
                      ) : null}
                      <span className="px-2 py-1 bg-blue-50 text-blue-600 rounded-full text-xs">
                        {room.modes.length} 种模式
                      </span>
                      {room.level && (
                        <span className={'px-2 py-1 rounded-full text-xs ' + (room.level === '7+' ? 'bg-purple-100 text-purple-700' : room.level === '5' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700')}>
                          {room.level === '7+' ? '7+ 分' : room.level + ' 分'}
                        </span>
                      )}
                    </div>
                    {/* 三点菜单 */}
                    <button
                      onClick={e => { e.stopPropagation(); setOpenMenuId(openMenuId === room.room_id ? null : room.room_id); }}
                      className="ml-2 -mr-1 px-2 py-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded text-lg leading-none shrink-0"
                      title="更多操作"
                    >⋯</button>
                    {openMenuId === room.room_id && (
                      <div
                        onClick={e => e.stopPropagation()}
                        className="absolute right-3 top-11 z-10 w-32 bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm"
                      >
                        <button onClick={() => { setOpenMenuId(null); setEditingId(room.room_id); }}
                          className="w-full text-left px-3 py-2 text-gray-700 hover:bg-gray-50">✏️ 备注</button>
                        <button onClick={() => { setOpenMenuId(null); deleteRoom(room); }}
                          className="w-full text-left px-3 py-2 text-red-600 hover:bg-red-50">🗑 删除房间</button>
                      </div>
                    )}
                  </div>
                  <span className="block text-xs text-gray-400 mt-1">
                    {room.answered_count}/{room.estimated_total} 题已答 · 进度 {room.progress_pct}% · 加入于 {formatDate(room.joined_at)}
                  </span>

                  {/* 进度条 */}
                  <div className="w-full bg-gray-100 rounded-full h-1.5 mt-3">
                    <div className="h-1.5 rounded-full bg-indigo-500 transition-all"
                      style={{ width: Math.min(room.progress_pct, 100) + '%' }} />
                  </div>

                  {/* 编辑备注（点三点菜单的"备注"后出现） */}
                  {editingId === room.room_id && (
                    <div className="mt-3 pt-3 border-t border-gray-100" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={noteInputs[room.room_id] || ''}
                          onChange={e => setNoteInputs(prev => ({ ...prev, [room.room_id]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') saveNote(room); }}
                          placeholder="给这个房间写个备注（如：重点练搭配）"
                          maxLength={200}
                          className="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded outline-none focus:ring-1 focus:ring-indigo-300"
                        />
                        <button onClick={() => saveNote(room)} disabled={savingNoteId === room.room_id}
                          className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">
                          {savingNoteId === room.room_id ? '保存中' : '保存'}
                        </button>
                        <button onClick={() => setEditingId(null)}
                          className="text-xs px-2 py-1.5 text-gray-500 hover:bg-gray-100 rounded">取消</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          );
        })}

        {/* 底部菜单 */}
        <div className="mt-6 flex gap-4 justify-center">
          <button onClick={() => navigate('/history')} className="px-6 py-3 bg-white rounded-lg shadow hover:shadow-md transition text-indigo-700 font-medium">
            练习历史
          </button>
        </div>
      </div>
    </div>
  );
}
