import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { getDateRange, withinRange, formatDate } from '../utils/dateFilter';

export default function History() {
  const [activeTab, setActiveTab] = useState('history');
  const [history, setHistory] = useState([]);
  const [weakWords, setWeakWords] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  // 薄弱词汇 筛选/排序状态
  const [sort, setSort] = useState('error_rate');
  const [order, setOrder] = useState('desc');
  const [minError, setMinError] = useState('');
  const [search, setSearch] = useState('');

  // 练习历史 日期筛选状态
  const [period, setPeriod] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // 每条历史的备注（草稿 + 保存中状态 + 展开编辑）
  const [noteInputs, setNoteInputs] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  // 三点菜单 + 删除中状态
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  // 练习历史：按备注/房间号/模式查找
  const [noteSearch, setNoteSearch] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [historyRes, weakWordsRes] = await Promise.all([
        api.getHistory(),
        api.getWeakWords()
      ]);
      setHistory(historyRes);
      const init = {};
      historyRes.forEach(h => { init[h.session_id] = h.note || ''; });
      setNoteInputs(init);
      setWeakWords(weakWordsRes);
    } catch (err) {
      console.error('加载数据失败', err);
    } finally {
      setLoading(false);
    }
  };

  const loadWeakWords = async () => {
    try {
      const params = { sort, order };
      if (minError !== '') params.min_error_rate = minError;
      if (search.trim() !== '') params.search = search.trim();
      const res = await api.getWeakWords(params);
      setWeakWords(res);
    } catch (err) {
      console.error('加载薄弱词汇失败', err);
    }
  };

  // 切换筛选/排序时重新拉取
  useEffect(() => {
    if (activeTab === 'weak') loadWeakWords();
    // eslint-disable-next-line
  }, [activeTab, sort, order, minError, search]);

  const saveHistoryNote = async (h) => {
    const note = (noteInputs[h.session_id] || '').slice(0, 200);
    setSavingId(h.session_id);
    try {
      await api.saveHistoryNote(h.session_id, note);
      setHistory(prev => prev.map(x => x.session_id === h.session_id ? { ...x, note } : x));
      setEditingId(null); // 保存后收起编辑框
    } catch (err) {
      console.error('保存备注失败', err);
      alert('备注保存失败：' + (err.message || '未知错误'));
    } finally {
      setSavingId(null);
    }
  };

  const deleteHistory = async (h) => {
    if (!window.confirm(`确定要永久删除这条练习记录吗？\n房间 ${h.room_code} · ${formatDate(h.finished_at)}\n删除后将无法恢复。`)) return;
    setDeletingId(h.session_id);
    try {
      await api.deleteHistory(h.session_id);
      setHistory(prev => prev.filter(x => x.session_id !== h.session_id));
      setMenuOpenId(null);
    } catch (err) {
      console.error('删除失败', err);
      alert('删除失败：' + (err.message || '未知错误'));
    } finally {
      setDeletingId(null);
    }
  };

  // 按提交日期筛选练习历史
  const range = getDateRange(period, from, to);
  const kw = noteSearch.trim().toLowerCase();
  const filteredHistory = history.filter(h => {
    if (!withinRange(h.finished_at, range)) return false;
    if (kw === '') return true;
    // 按备注 / 房间号 / 模式 模糊查找
    const hay = [h.note || '', h.room_code || '', h.mode_type || ''].join(' ').toLowerCase();
    return hay.includes(kw);
  });

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-2xl mx-auto">
        {/* 顶部 */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-800">我的数据</h1>
          <button
            onClick={() => navigate('/')}
            className="text-indigo-600 hover:text-indigo-800 text-sm"
          >
            返回首页
          </button>
        </div>

        {/* Tab 切换 */}
        <div className="bg-white rounded-xl shadow-sm mb-4">
          <div className="flex border-b">
            <button
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-3 font-medium text-sm ${activeTab === 'history' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500'}`}
            >
              练习历史
            </button>
            <button
              onClick={() => setActiveTab('weak')}
              className={`flex-1 py-3 font-medium text-sm ${activeTab === 'weak' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500'}`}
            >
              薄弱词汇
            </button>
          </div>
        </div>

        {/* 练习历史 */}
        {activeTab === 'history' && (
          <div className="space-y-3">
            {/* 日期筛选控制条 */}
            <div className="bg-white rounded-xl shadow-sm p-3 space-y-2">
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
              <div className="flex items-center gap-2">
                <input
                  value={noteSearch}
                  onChange={e => setNoteSearch(e.target.value)}
                  placeholder="查找备注 / 房间号 / 模式…"
                  className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-indigo-300"
                />
                {noteSearch && (
                  <button onClick={() => setNoteSearch('')}
                    className="text-xs text-gray-400 hover:text-gray-600 px-1">✕</button>
                )}
              </div>
              <p className="text-[10px] text-gray-400">
                共 {filteredHistory.length} 条记录
                {period !== 'all' && `（已按${period === 'custom' ? '自定义区间' : ({ today: '今天', week: '本周', month: '本月' }[period])}筛选）`}
                {kw !== '' && `（关键词「${noteSearch.trim()}」匹配 ${filteredHistory.length} 条）`}
              </p>
            </div>

            {history.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-8 text-center text-gray-400">
                暂无练习记录
              </div>
            ) : filteredHistory.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-8 text-center text-gray-400">
                {kw !== '' ? `没有匹配「${noteSearch.trim()}」的练习记录` : '该日期范围内暂无练习记录'}
              </div>
            ) : (
              filteredHistory.map((h, i) => (
                <div key={i} className="relative bg-white rounded-xl shadow-sm p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-gray-800">房间 {h.room_code}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-500">{formatDate(h.finished_at)}</span>
                      {/* 三点菜单按钮 */}
                      <button
                        onClick={() => setMenuOpenId(menuOpenId === h.session_id ? null : h.session_id)}
                        className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1"
                        title="更多操作"
                      >⋯</button>
                    </div>
                  </div>

                  {/* 三点下拉菜单 */}
                  {menuOpenId === h.session_id && (
                    <div className="absolute right-4 top-12 z-10 w-32 bg-white rounded-lg shadow-lg border border-gray-100 py-1">
                      <button
                        onClick={() => { setEditingId(h.session_id); setMenuOpenId(null); }}
                        className="block w-full text-left px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
                      >✏️ 备注</button>
                      <button
                        onClick={() => { setMenuOpenId(null); deleteHistory(h); }}
                        disabled={deletingId === h.session_id}
                        className="block w-full text-left px-3 py-2 text-xs text-red-500 hover:bg-red-50 disabled:opacity-50"
                      >🗑 删除</button>
                    </div>
                  )}

                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-indigo-600 font-medium">{h.score}分</span>
                    <span className="text-gray-500">
                      答对 {h.correct_count}/{h.total_questions}
                    </span>
                    <span className="text-gray-400">{h.mode_type}</span>
                  </div>

                  {/* 本条历史的备注 — 紧凑内联风格 */}
                  <div className="mt-2 pt-2 border-t border-gray-100">
                    {editingId === h.session_id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          value={noteInputs[h.session_id] || ''}
                          onChange={e => setNoteInputs(prev => ({ ...prev, [h.session_id]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') saveHistoryNote(h); if (e.key === 'Escape') setEditingId(null); }}
                          placeholder="写备注…"
                          maxLength={200}
                          autoFocus
                          className="flex-1 text-xs px-2 py-1 border border-gray-300 rounded outline-none focus:ring-1 focus:ring-indigo-300"
                        />
                        <button onClick={() => saveHistoryNote(h)} disabled={savingId === h.session_id}
                          className="text-[11px] px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">
                          {savingId === h.session_id ? '…' : 'OK'}
                        </button>
                        <button onClick={() => setEditingId(null)}
                          className="text-[11px] px-2 py-1 text-gray-400 hover:text-gray-600 rounded border border-gray-200">
                          取消
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        {h.note ? (
                          <span className="text-[11px] text-gray-400">备注：{h.note}</span>
                        ) : (
                          <span className="text-[11px] text-gray-300">暂无备注</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* 薄弱词汇 */}
        {activeTab === 'weak' && (
          <div className="space-y-2">
            {/* 紧凑筛选 / 排序控制条（单行） */}
            <div className="bg-white rounded-xl shadow-sm px-3 py-2 flex items-center gap-2">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="搜索词汇"
                className="flex-1 min-w-0 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-300"
              />
              <select
                value={sort}
                onChange={e => setSort(e.target.value)}
                className="text-xs border border-gray-200 rounded px-2 py-1 bg-white outline-none"
              >
                <option value="error_rate">错误率</option>
                <option value="error_count">错误次数</option>
                <option value="total_attempts">练习次数</option>
                <option value="recent">最近练习</option>
              </select>
              <select
                value={order}
                onChange={e => setOrder(e.target.value)}
                className="text-xs border border-gray-200 rounded px-2 py-1 bg-white outline-none"
                title="排序方向"
              >
                <option value="desc">高→低</option>
                <option value="asc">低→高</option>
              </select>
            </div>

            {weakWords.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-8 text-center text-gray-400">
                暂无薄弱词汇记录
              </div>
            ) : (
              weakWords.map((w, i) => (
                <div key={i} className="bg-white rounded-xl shadow-sm px-4 py-2.5 flex items-center justify-between">
                  <span className="font-medium text-gray-800 truncate">{w.word}</span>
                  <div className="flex items-center gap-3 text-xs shrink-0">
                    <span className="text-gray-400">错{w.error_count}/共{w.total_attempts}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${w.error_rate > 50 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>
                      {w.error_rate}%
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
