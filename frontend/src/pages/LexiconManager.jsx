import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { logout } from '../auth';

const FIELDS = [
  { key: 'word', label: '单词 / 短语', type: 'text', required: true },
  { key: 'pos', label: '词性', type: 'text' },
  { key: 'phonetic', label: '音标', type: 'text' },
  { key: 'chinese', label: '中文释义', type: 'text' },
  { key: 'definition_en', label: '英文释义 (definition)', type: 'textarea' },
  { key: 'synonym1', label: '同义替换 1', type: 'text' },
  { key: 'synonym2', label: '同义替换 2', type: 'text' },
  { key: 'synonym3', label: '同义替换 3', type: 'text' },
  { key: 'easy_sentence', label: '易句（3.5 分，含 ______ 挖空）', type: 'textarea' },
  { key: 'part3_sentence', label: 'Part3 句（4 分，含 ______ 挖空）', type: 'textarea' },
  { key: 'sentence_cn_easy', label: '易句中文翻译', type: 'text' },
  { key: 'sentence_cn_part3', label: 'Part3 句中文翻译', type: 'text' },
];

const CSV_HEADER = ['word','pos','phonetic','chinese','definition_en','synonym1','synonym2','synonym3','easy_sentence','part3_sentence','sentence_cn_easy','sentence_cn_part3'];

function csvEscape(v) {
  const s = (v == null ? '' : String(v));
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const blankEntry = () => ({
  word: '', pos: '', phonetic: '', chinese: '', definition_en: '',
  synonym1: '', synonym2: '', synonym3: '',
  easy_sentence: '', part3_sentence: '',
  sentence_cn_easy: '', sentence_cn_part3: ''
});

export default function LexiconManager() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState(null); // entry object or null
  const [isNew, setIsNew] = useState(false);

  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMsg, setImportMsg] = useState('');

  const navigate = useNavigate();

  const load = useCallback(async (query) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getLexicon(query || '');
      setItems(res.items || []);
      setTotal(res.total || (res.items || []).length);
    } catch (err) {
      console.error(err);
      setError(err.message || '加载词库失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(''); }, [load]);

  function handleSearch() { load(q.trim()); }
  function handleClearSearch() { setQ(''); load(''); }

  function openNew() {
    setEditing(blankEntry());
    setIsNew(true);
    setError('');
  }
  function openEdit(item) {
    setEditing({ ...item });
    setIsNew(false);
    setError('');
  }
  function closeEdit() { setEditing(null); setIsNew(false); }

  function onField(key, val) {
    setEditing(prev => ({ ...prev, [key]: val }));
  }

  async function handleSave() {
    if (!editing.word || !editing.word.trim()) {
      setError('单词不能为空');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (isNew) {
        await api.createLexicon(editing);
      } else {
        await api.updateLexicon(editing.id, editing);
      }
      closeEdit();
      await load(q.trim());
    } catch (err) {
      setError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editing || isNew) return;
    if (!window.confirm('确定删除「' + editing.word + '」吗？')) return;
    setSaving(true);
    try {
      await api.deleteLexicon(editing.id);
      closeEdit();
      await load(q.trim());
    } catch (err) {
      setError(err.message || '删除失败');
    } finally {
      setSaving(false);
    }
  }

  function exportCSV() {
    const lines = [CSV_HEADER.join(',')];
    for (const it of items) {
      lines.push(CSV_HEADER.map(h => csvEscape(it[h])).join(','));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lexicon_' + (q ? q + '_' : '') + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport() {
    setImportMsg('解析中...');
    try {
      const rows = parseCSV(importText);
      if (rows.length === 0) { setImportMsg('没有可导入的数据'); return; }
      const header = rows[0].map(h => h.trim());
      const dataRows = rows.slice(1);
      let ok = 0, skip = 0;
      for (const r of dataRows) {
        const obj = {};
        header.forEach((h, i) => { if (CSV_HEADER.includes(h)) obj[h] = (r[i] || '').trim(); });
        if (!obj.word) { skip++; continue; }
        await api.createLexicon(obj);
        ok++;
      }
      setImportMsg(`导入完成：新增/更新 ${ok} 条，跳过 ${skip} 条（无单词）。`);
      await load(q.trim());
    } catch (e) {
      setImportMsg('导入失败：' + e.message);
    }
  }

  function handleLogout() { logout(); window.location.href = '/teacher'; }

  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-100">
      <nav className="bg-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/admin')} className="text-red-600 hover:text-red-800 text-sm">← 返回管理员后台</button>
            <h1 className="text-xl font-bold text-red-700">审定词库</h1>
            <span className="px-2 py-0.5 rounded-full bg-pink-100 text-pink-700 text-xs font-medium">雅思 3-4 分</span>
          </div>
          <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800">退出</button>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto p-6">
        <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-gray-800">词汇与例句库</h2>
              <p className="text-sm text-gray-500 mt-1">
                共 <strong className="text-indigo-600">{total}</strong> 个词条 · 易句为 3.5 分水平，Part3 句为 4 分水平
                <span className="ml-1 px-1.5 py-0.5 rounded bg-pink-100 text-pink-700 text-[11px] font-medium">4 分</span> 标签代表该词库用于 band 4 的 Part3 练习
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button onClick={openNew} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition text-sm font-medium">＋ 新增词条</button>
              <button onClick={exportCSV} className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm">导出 CSV</button>
              <button onClick={() => { setShowImport(true); setImportMsg(''); }} className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm">导入 CSV</button>
            </div>
          </div>

          <div className="flex gap-2 mt-4">
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
              placeholder="搜索单词 / 中文 / 英文释义"
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
            />
            <button onClick={handleSearch} className="px-5 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition text-sm">搜索</button>
            {q && <button onClick={handleClearSearch} className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition text-sm">清除</button>}
          </div>
        </div>

        {error && <p className="text-red-600 text-sm bg-red-50 p-3 rounded mb-4">{error}</p>}

        <div className="bg-white rounded-2xl shadow-lg p-6">
          {loading ? (
            <p className="text-center text-gray-400 py-10">加载中...</p>
          ) : items.length === 0 ? (
            <p className="text-center text-gray-500 py-10">暂无词条，点击「＋ 新增词条」或「导入 CSV」</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-3 font-medium">单词</th>
                    <th className="py-2 pr-3 font-medium">词性</th>
                    <th className="py-2 pr-3 font-medium">中文</th>
                    <th className="py-2 pr-3 font-medium">英文释义</th>
                    <th className="py-2 pr-3 font-medium">同义替换</th>
                    <th className="py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(it => (
                    <tr key={it.id} className="border-b border-gray-100 hover:bg-indigo-50/40 transition">
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-gray-800">{it.word}</span>
                          <span className="px-1.5 py-0.5 rounded bg-pink-100 text-pink-700 text-[10px] font-medium whitespace-nowrap">4 分</span>
                        </div>
                        {it.phonetic && <span className="text-xs text-gray-400">{it.phonetic}</span>}
                      </td>
                      <td className="py-2 pr-3 text-gray-500">{it.pos || '—'}</td>
                      <td className="py-2 pr-3 text-gray-600 max-w-[160px] truncate">{it.chinese || '—'}</td>
                      <td className="py-2 pr-3 text-gray-600 max-w-[220px] truncate">{it.definition_en || '—'}</td>
                      <td className="py-2 pr-3 text-gray-500 max-w-[180px] truncate">
                        {[it.synonym1, it.synonym2, it.synonym3].filter(Boolean).join(' / ') || '—'}
                      </td>
                      <td className="py-2">
                        <button onClick={() => openEdit(it)} className="px-3 py-1.5 bg-indigo-100 text-indigo-700 rounded-lg hover:bg-indigo-200 transition text-xs">查看 / 编辑</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 编辑抽屉 */}
      {editing && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-end z-50">
          <div className="bg-white w-full max-w-lg h-full overflow-y-auto shadow-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-800">{isNew ? '新增词条' : '编辑词条'}</h3>
              <button onClick={closeEdit} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
            </div>
            {error && <p className="text-red-600 text-sm bg-red-50 p-3 rounded mb-4">{error}</p>}
            <div className="space-y-4">
              {FIELDS.map(f => (
                <div key={f.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}
                  </label>
                  {f.type === 'textarea' ? (
                    <textarea
                      value={editing[f.key] || ''}
                      onChange={e => onField(f.key, e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                    />
                  ) : (
                    <input
                      value={editing[f.key] || ''}
                      onChange={e => onField(f.key, e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-6 sticky bottom-0 bg-white pt-4 border-t border-gray-100">
              {!isNew && (
                <button onClick={handleDelete} disabled={saving} className="px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition text-sm disabled:opacity-50">删除</button>
              )}
              <div className="flex-1"></div>
              <button onClick={closeEdit} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm">取消</button>
              <button onClick={handleSave} disabled={saving} className="px-5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium text-sm disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 导入 CSV 弹窗 */}
      {showImport && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-800">导入 CSV</h3>
              <button onClick={() => setShowImport(false)} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
            </div>
            <p className="text-xs text-gray-500 mb-2">首行需为表头：{CSV_HEADER.join(', ')}</p>
            <textarea
              value={importText}
              onChange={e => setImportText(e.target.value)}
              rows={10}
              placeholder="将 CSV 内容粘贴到此处（含表头）"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-xs focus:ring-2 focus:ring-indigo-500"
            />
            {importMsg && <p className="text-sm text-indigo-600 mt-2">{importMsg}</p>}
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => setShowImport(false)} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm">关闭</button>
              <button onClick={handleImport} className="px-5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium text-sm">开始导入</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
