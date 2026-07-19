import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { logout } from '../auth';
import { MODES } from '../modes';

/** 清洗单个词条：去掉中文、词性标注（adj./v. 等）、括号注释，只保留纯英文单词 */
function cleanVocabEntry(s) {
  if (typeof s !== 'string') return (s || '').trim();
  return s
    .replace(/[一-鿿㐀-䶿]/g, '')                                                       // 去掉所有中文字符
    .replace(/(?:^|\s)(?:adj|adv|prep|conj|pron|det|int|aux|art|num|abbr|phr|vi|vt|n|v)\.?(?=[\s,，.;；、。！？!?]|\)|$)/gi, ' ') // 独立词性标注
    .replace(/[_\-](?:adj|adv|prep|conj|pron|det|int|aux|art|num|abbr|phr|vi|vt|n|v)\.?/gi, '')     // 附着词性
    .replace(/\s*[（（][^））]*[））]\s*/g, ' ')                                          // 中文括号注释
    .replace(/\s*\([^)]*\)\s*/g, ' ')                                                     // 英文括号注释
    .replace(/\s+/g, ' ')
    .trim();
}

export default function Dashboard() {
  const [rooms, setRooms] = useState([]);
  const [error, setError] = useState('');
  const [teacherName, setTeacherName] = useState('');
  const [deletingCode, setDeletingCode] = useState('');
  const [selectedRooms, setSelectedRooms] = useState([]);
  const [batchDeleting, setBatchDeleting] = useState(false);

  // 向导
  const [showWizard, setShowWizard] = useState(false);
  const [step, setStep] = useState(1);
  const [vocabText, setVocabText] = useState('');
  const [words, setWords] = useState([]);
  const [selectedModes, setSelectedModes] = useState([]);
  const [assignMap, setAssignMap] = useState({});
  const [currentMode, setCurrentMode] = useState('');
  const [selectedWords, setSelectedWords] = useState([]);
  const [allowRepeat, setAllowRepeat] = useState(false);
  const [modeCounts, setModeCounts] = useState({});
  const [roomLevel, setRoomLevel] = useState('6');
  const [creating, setCreating] = useState(false);

  const navigate = useNavigate();

  useEffect(() => { loadRooms(); loadTeacherInfo(); }, []);

  function loadTeacherInfo() {
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      setTeacherName(user.name || '');
    } catch {}
  }

  async function loadRooms() {
    try {
      const res = await api.getRooms();
      setRooms(res.data || res);
    } catch (err) { console.error('加载房间失败', err); }
  }

  // ===== 向导 =====
  function openWizard() {
    setShowWizard(true);
    setStep(1);
    setVocabText('');
    setWords([]);
    setSelectedModes([]);
    setAssignMap({});
    setCurrentMode('');
    setSelectedWords([]);
    setAllowRepeat(false);
    setModeCounts({});
    setRoomLevel('6');
    setError('');
  }

  function closeWizard() {
    setShowWizard(false);
  }

  function wizardNext() {
    if (step === 1) {
      const raw = vocabText.split(/,|\n/).map(v => v.trim()).filter(v => v);
      // 去重（大小写不敏感，保留首次出现的写法）
      const seen = new Set();
      const unique = [];
      raw.forEach(w => {
        const key = w.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(w);
      });
      if (unique.length === 0) { setError('请至少输入一个单词'); return; }
      // 自动清洗：去掉中文、词性标注等，只保留纯英文单词；对含中文/词性的词条给出友好提示
      const cleaned = unique.map(w => ({ raw: w, clean: cleanVocabEntry(w) }));
      const dirtyItems = cleaned.filter(c => c.raw !== c.clean && c.clean);
      if (dirtyItems.length > 0) {
        setError('💡 已自动清洗以下词条的中文/词性标注：\n' + dirtyItems.map(c => `${c.raw} → ${c.clean}`).join('、'));
        // 不 return，继续用清洗后的词进入下一步
      } else {
        setError('');
      }
      const words = cleaned.map(c => c.clean).filter(Boolean);
      if (words.length === 0) { setError('输入的词条清洗后为空，请检查格式'); return; }
      setWords(words);
      setStep(2);
      setError('');
    } else if (step === 2) {
      if (selectedModes.length === 0) { setError('请至少选择一种练习方式'); return; }
      const init = {};
      selectedModes.forEach(m => { init[m] = []; });
      setAssignMap(init);
      setCurrentMode(selectedModes[0]);
      setStep(3);
      setError('');
    } else if (step === 3) {
      setStep(4);
    }
  }

  function wizardBack() {
    if (step > 1) setStep(step - 1);
  }

  function toggleMode(modeId) {
    setSelectedModes(prev =>
      prev.includes(modeId) ? prev.filter(m => m !== modeId) : [...prev, modeId]
    );
  }

  function toggleWord(word) {
    setSelectedWords(prev =>
      prev.includes(word) ? prev.filter(w => w !== word) : [...prev, word]
    );
  }

  function assignToMode() {
    if (selectedWords.length === 0) return;
    setAssignMap(prev => ({
      ...prev,
      [currentMode]: [...new Set([...(prev[currentMode] || []), ...selectedWords])]
    }));
    setSelectedWords([]);
  }

  function removeWord(word, modeId) {
    setAssignMap(prev => ({
      ...prev,
      [modeId]: (prev[modeId] || []).filter(w => w !== word)
    }));
  }

  // 一键随机分配：把所有可分配的词汇随机分到各练习方式
  function randomAssign() {
    if (selectedModes.length === 0) return;
    let pool;
    if (allowRepeat) {
      // 重复模式：所有词汇都可再随机分配一个方式
      pool = [...words];
    } else {
      // 非重复模式：只取尚未分配到任何方式的词汇
      const assigned = new Set();
      Object.values(assignMap).forEach(ws => (ws || []).forEach(w => assigned.add(w)));
      pool = words.filter(w => !assigned.has(w));
    }
    if (pool.length === 0) { alert('没有可随机分配的词汇了'); return; }
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    setAssignMap(prev => {
      const next = { ...prev };
      selectedModes.forEach(m => { if (!next[m]) next[m] = []; });
      shuffled.forEach(w => {
        const target = selectedModes[Math.floor(Math.random() * selectedModes.length)];
        if (!next[target].includes(w)) next[target].push(w);
      });
      return next;
    });
  }

  // 清空所有分配
  function clearAssign() {
    const empty = {};
    selectedModes.forEach(m => { empty[m] = []; });
    setAssignMap(empty);
    setSelectedWords([]);
  }

  // 按数量分配：教师为每个方式指定词汇数量，系统随机填充
  function assignByCount() {
    if (selectedModes.length === 0) return;
    const counts = selectedModes.map(m => parseInt(modeCounts[m] || '0', 10) || 0);
    const totalWanted = counts.reduce((a, b) => a + b, 0);
    if (totalWanted === 0) { alert('请先为每个方式输入数量'); return; }

    const next = {};
    selectedModes.forEach(m => { next[m] = []; });

    if (!allowRepeat) {
      // 非重复：从全体词池按顺序随机取，每个词只能用一次
      const shuffled = [...words].sort(() => Math.random() - 0.5);
      let idx = 0;
      selectedModes.forEach((m, i) => {
        const n = counts[i];
        for (let k = 0; k < n && idx < shuffled.length; k++) {
          next[m].push(shuffled[idx++]);
        }
      });
      const assigned = idx;
      setAssignMap(next);
      if (assigned < totalWanted) {
        alert('词汇总数不足，已分配 ' + assigned + ' 个（需要 ' + totalWanted + ' 个）');
      }
    } else {
      // 重复模式：每个方式独立从全体词中随机取（可重复）
      selectedModes.forEach((m, i) => {
        const n = counts[i];
        const pool = [...words].sort(() => Math.random() - 0.5);
        for (let k = 0; k < n && k < pool.length; k++) {
          if (!next[m].includes(pool[k])) next[m].push(pool[k]);
        }
      });
      setAssignMap(next);
    }
  }

  async function handleCreateRoom() {
    setCreating(true);
    setError('');
    try {
      // 只取已分配的词汇，合并去重
      const assignedWords = [...new Set(
        Object.values(assignMap).flat().filter(Boolean)
      )];
      const res = await api.createRoom({
        vocabulary_list: assignedWords,
        practice_modes: selectedModes,
        mode_word_map: assignMap,
        level: roomLevel
      });
      alert('房间创建成功！房间号：' + (res.room_code || res.data?.room_code));
      setShowWizard(false);
      setVocabText('');
      loadRooms();
    } catch (err) {
      console.error('创建房间失败', err);
      setError(err.response?.data?.error || err.message || '创建房间失败');
    } finally {
      setCreating(false);
    }
  }

  // ===== 删除 =====
  async function handleDeleteRoom(roomCode) {
    if (!window.confirm('确定要删除房间 #' + roomCode + ' 吗？')) return;
    setDeletingCode(roomCode);
    try {
      await api.deleteRoom(roomCode);
      alert('房间已删除');
      setSelectedRooms(prev => prev.filter(c => c !== roomCode));
      loadRooms();
    } catch (err) {
      setError('删除失败');
    } finally {
      setDeletingCode('');
    }
  }

  async function handleBatchDelete() {
    if (selectedRooms.length === 0) return;
    if (!window.confirm('确定要删除选中的 ' + selectedRooms.length + ' 个房间吗？')) return;
    setBatchDeleting(true);
    try {
      await Promise.all(selectedRooms.map(code => api.deleteRoom(code)));
      alert('已删除 ' + selectedRooms.length + ' 个房间');
      setSelectedRooms([]);
      loadRooms();
    } catch (err) {
      setError('部分房间删除失败');
    } finally {
      setBatchDeleting(false);
    }
  }

  function toggleSelectRoom(roomCode) {
    setSelectedRooms(prev =>
      prev.includes(roomCode) ? prev.filter(c => c !== roomCode) : [...prev, roomCode]
    );
  }

  function toggleSelectAll() {
    if (selectedRooms.length === rooms.length) {
      setSelectedRooms([]);
    } else {
      setSelectedRooms(rooms.map(r => r.room_code));
    }
  }

  function copyRoomCode(roomCode) {
    navigator.clipboard.writeText(roomCode);
    alert('房间号已复制！');
  }

  function handleLogout() {
    logout();
    window.location.href = '/teacher';
  }

  function goToRoom(roomCode) {
    navigate('/room/' + roomCode);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <nav className="bg-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex justify-between items-center">
          <h1 className="text-xl font-bold text-indigo-700">教师控制台</h1>
          <div className="flex items-center gap-4">
            <span className="text-gray-700">{teacherName}，你好！</span>
            <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800">退出</button>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto p-6">
        {/* 创建房间按钮 */}
        <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-800">创建练习房间</h2>
              <p className="text-sm text-gray-500 mt-1">点击按钮，按步骤设置词汇和练习方式</p>
            </div>
            <button
              onClick={openWizard}
              className="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition font-medium"
            >
              ＋ 创建房间
            </button>
          </div>
        </div>

        {/* 房间列表 */}
        <div className="bg-white rounded-2xl shadow-lg p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold text-gray-800">我的房间</h2>
            {rooms.length > 0 && (
              <div className="flex items-center gap-3">
                {selectedRooms.length > 0 && (
                  <button
                    onClick={handleBatchDelete}
                    disabled={batchDeleting}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm font-medium disabled:opacity-50"
                  >
                    {batchDeleting ? '删除中...' : '删除选中 (' + selectedRooms.length + ')'}
                  </button>
                )}
                <label className="flex items-center gap-1 text-sm text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rooms.length > 0 && selectedRooms.length === rooms.length}
                    onChange={toggleSelectAll}
                    className="w-4 h-4"
                  />
                  全选
                </label>
              </div>
            )}
          </div>
          {rooms.length === 0 ? (
            <p className="text-gray-500 text-center py-8">暂无房间，请先创建一个</p>
          ) : (
            <div className="space-y-3">
              {rooms.map(room => (
                <div key={room.id} className="border border-gray-200 rounded-lg p-4 hover:border-indigo-300 transition cursor-pointer" onClick={() => goToRoom(room.room_code)}>
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-3 flex-1">
                      <input
                        type="checkbox"
                        checked={selectedRooms.includes(room.room_code)}
                        onChange={e => { e.stopPropagation(); toggleSelectRoom(room.room_code); }}
                        onClick={e => e.stopPropagation()}
                        className="w-4 h-4 cursor-pointer"
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <p className="font-bold text-lg text-indigo-700">#{room.room_code}</p>
                          <span className={'px-2 py-1 rounded-full text-xs ' + (room.level === '7+' ? 'bg-purple-100 text-purple-700' : room.level === '5' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700')}>
                            {room.level === '7+' ? '7+ 分' : room.level === '5' ? '5 分' : '6 分'}
                          </span>
                          <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs">
                            {(room.student_count || 0) + ' 名学生'}
                          </span>
                        </div>
                        <p className="text-sm text-gray-600 mt-1">
                          {'词汇数：' + (room.vocabulary_list?.length || 0) + ' | 创建时间：' + new Date(room.created_at).toLocaleString('zh-CN')}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2 ml-4" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => copyRoomCode(room.room_code)}
                        className="px-3 py-2 bg-indigo-100 text-indigo-700 rounded-lg hover:bg-indigo-200 transition text-sm"
                      >
                        复制
                      </button>
                      <button
                        onClick={() => handleDeleteRoom(room.room_code)}
                        disabled={deletingCode === room.room_code}
                        className="px-3 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition text-sm disabled:opacity-50"
                      >
                        {deletingCode === room.room_code ? '删除中...' : '删除'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ===== 向导弹窗 ===== */}
      {showWizard && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-screen overflow-y-auto">
            {/* 头部 */}
            <div className="sticky top-0 bg-white border-b border-gray-200 p-6 rounded-t-2xl">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-800">创建练习房间</h2>
                <button onClick={closeWizard} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
              </div>
              {/* 步骤条 */}
              <div className="flex items-center gap-2">
                {[1, 2, 3, 4].map(s => (
                  <div key={s} className="flex items-center gap-2">
                    <div className={'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ' + (step === s ? 'bg-indigo-600 text-white' : step > s ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500')}>
                      {step > s ? '✓' : s}
                    </div>
                    {s < 4 && <div className={'flex-1 h-1 ' + (step > s ? 'bg-green-500' : 'bg-gray-200')} style={{width:'40px'}}></div>}
                  </div>
                ))}
              </div>
              <div className="flex justify-between mt-2 text-xs text-gray-500">
                <span>输入词汇</span>
                <span>选择方式</span>
                <span>分配词汇</span>
                <span>确认</span>
              </div>
            </div>

            <div className="p-6">
              {error && <p className="text-red-600 text-sm bg-red-50 p-3 rounded mb-4">{error}</p>}

              {/* Step 1 */}
              {step === 1 && (
                <div>
                  <h3 className="text-lg font-bold text-gray-800 mb-4">① 输入词汇</h3>
                  <p className="text-sm text-gray-500 mb-2">支持英文逗号分隔，或每行一个单词</p>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                    <p className="text-xs text-amber-700 font-medium">📌 请确保只输入<strong>纯英文单词</strong>，不要包含中文释义、词性（adj./n./v.）或括号注释</p>
                    <p className="text-xs text-amber-600 mt-0.5">正确示例：ubiquitous, detrimental, inevitable</p>
                    <p className="text-xs text-red-500 mt-0.5">错误示例：ubiquitous adj. 普遍的, detrimental adj. 有害的</p>
                  </div>
                  <textarea
                    value={vocabText}
                    onChange={e => setVocabText(e.target.value)}
                    placeholder={'方式一（逗号分隔）：ubiquitous, detrimental, inevitable\n方式二（每行一个）：\nubiquitous\ndetrimental\ninevitable'}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono"
                    rows={8}
                  />
                  {(() => {
                    const raw = vocabText.split(/,|\n/).map(v => v.trim()).filter(v => v);
                    const seen = new Set();
                    let dup = 0;
                    const uniq = [];
                    raw.forEach(w => {
                      const k = w.toLowerCase();
                      if (seen.has(k)) dup++;
                      else { seen.add(k); uniq.push(w); }
                    });
                    return (
                      <p className="text-xs text-gray-400 mt-2">
                        {'共 ' + raw.length + ' 个（去重后 ' + uniq.length + (dup > 0 ? '，自动去除 ' + dup + ' 个重复' : '') + '）'}
                      </p>
                    );
                  })()}

                  {/* 目标学生水平 */}
                  <div className="mt-5 pt-4 border-t border-gray-100">
                    <p className="text-sm font-medium text-gray-700 mb-2">目标学生水平（生成句子的难度）</p>
                    <div className="flex gap-2">
                      {[
                        { v: '5', t: '5 分', d: '简单句为主' },
                        { v: '6', t: '6 分', d: '含 1 个从句' },
                        { v: '7+', t: '7+ 分', d: '高级复杂句型' },
                      ].map(opt => (
                        <button
                          key={opt.v}
                          onClick={() => setRoomLevel(opt.v)}
                          className={'flex-1 px-3 py-2 rounded-lg border text-center transition ' + (roomLevel === opt.v ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-indigo-300')}
                        >
                          <div className="font-medium text-sm">{opt.t}</div>
                          <div className="text-[10px] text-gray-400 mt-0.5">{opt.d}</div>
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2">将尽量生成雅思口语 Part 3 风格的句子，并按所选水平控制复杂度。</p>
                  </div>
                </div>
              )}

              {/* Step 2 */}
              {step === 2 && (
                <div>
                  <h3 className="text-lg font-bold text-gray-800 mb-4">② 选择练习方式</h3>
                  <p className="text-sm text-gray-500 mb-4">可多选</p>
                  <div className="space-y-3">
                    {MODES.map(mode => (
                      <div
                        key={mode.id}
                        onClick={() => toggleMode(mode.id)}
                        className={'p-4 border-2 rounded-lg cursor-pointer transition ' + (selectedModes.includes(mode.id) ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300')}
                      >
                        <div className="flex items-center gap-3">
                          <div className={'w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ' + (selectedModes.includes(mode.id) ? 'border-indigo-500 bg-indigo-500' : 'border-gray-300')}>
                            {selectedModes.includes(mode.id) && <span className="text-white text-xs">✓</span>}
                          </div>
                          <span className="font-medium text-gray-800">{mode.label}</span>
                          {mode.usesBuiltinBank && (
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200 whitespace-nowrap">内置题库</span>
                          )}
                        </div>
                        {mode.usesBuiltinBank && (
                          <p className="text-xs text-amber-600 mt-2 ml-8 flex items-start gap-1">
                            <span>⚠️</span>
                            <span>{mode.bankNote}</span>
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Step 3 */}
              {step === 3 && (
                <div>
                  <h3 className="text-lg font-bold text-gray-800 mb-4">③ 分配词汇到练习方式</h3>

                  {/* 内置题库模式提醒：这些模式不使用所给词汇表，无需分配 */}
                  {selectedModes.some(id => MODES.find(m => m.id === id)?.usesBuiltinBank) && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                      <p className="text-sm font-medium text-amber-700 mb-1">⚠️ 以下练习形式使用系统内置题库，无需分配词汇：</p>
                      <ul className="text-xs text-amber-600 space-y-0.5 ml-1">
                        {selectedModes.filter(id => MODES.find(m => m.id === id)?.usesBuiltinBank).map(id => {
                          const mode = MODES.find(m => m.id === id);
                          return <li key={id}>· {mode.label}：{mode.bankNote}</li>;
                        })}
                      </ul>
                    </div>
                  )}

                  {/* 重复分配开关 */}
                  <div className="bg-gray-50 p-4 rounded-lg mb-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-700">允许重复分配</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {allowRepeat ? '同一个词汇可以分配到多种练习方式' : '每个词汇只能分配到一种练习方式（已分配的词汇不会出现在其他方式中）'}
                      </p>
                    </div>
                    <button
                      onClick={() => setAllowRepeat(!allowRepeat)}
                      className={'relative w-12 h-6 rounded-full transition ' + (allowRepeat ? 'bg-indigo-600' : 'bg-gray-300')}
                    >
                      <span className={'absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition ' + (allowRepeat ? 'left-6' : 'left-0.5')}></span>
                    </button>
                  </div>

                  {/* 一键随机分配 */}
                  <div className="bg-indigo-50 p-4 rounded-lg mb-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-indigo-700">🎲 一键随机分配</p>
                      <p className="text-xs text-indigo-500 mt-1">把所有词汇随机分到各方式，省去逐词勾选</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={clearAssign}
                        className="px-3 py-2 bg-white text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition text-sm"
                      >
                        清空
                      </button>
                      <button
                        onClick={randomAssign}
                        className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition text-sm font-medium"
                      >
                        随机分配
                      </button>
                    </div>
                  </div>

                  {/* 按数量分配 */}
                  <div className="bg-emerald-50 p-4 rounded-lg mb-4">
                    <p className="text-sm font-medium text-emerald-700 mb-1">📊 按数量分配</p>
                    <p className="text-xs text-emerald-600 mb-3">为每个方式指定词汇数量，系统自动随机分配</p>
                    <div className="space-y-2">
                      {selectedModes.map(modeId => {
                        const mode = MODES.find(m => m.id === modeId);
                        return (
                          <div key={modeId} className="flex items-center justify-between gap-2">
                            <span className="text-sm text-gray-700 flex-1">{mode.label}</span>
                            <input
                              type="number"
                              min="0"
                              value={modeCounts[modeId] || ''}
                              onChange={e => setModeCounts(prev => ({ ...prev, [modeId]: e.target.value }))}
                              placeholder="0"
                              className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-center focus:ring-2 focus:ring-emerald-400"
                            />
                            <span className="text-xs text-gray-400">个词</span>
                          </div>
                        );
                      })}
                    </div>
                    <button
                      onClick={assignByCount}
                      className="w-full mt-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition text-sm font-medium"
                    >
                      按数量随机分配
                    </button>
                  </div>

                  <p className="text-sm text-gray-500 mb-4">先选择练习方式标签，再点击词汇选中，最后点「分配」按钮</p>

                  {/* 方式标签 */}
                  <div className="flex flex-wrap gap-2 mb-4">
                    {selectedModes.map(modeId => {
                      const mode = MODES.find(m => m.id === modeId);
                      return (
                        <button
                          key={modeId}
                          onClick={() => { setCurrentMode(modeId); setSelectedWords([]); }}
                          className={'px-3 py-2 rounded-lg text-sm font-medium transition ' + (currentMode === modeId ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')}
                        >
                          {mode.label + ' (' + (assignMap[modeId] || []).length + ')'}
                        </button>
                      );
                    })}
                  </div>

                  <div className="bg-indigo-50 p-3 rounded-lg mb-4">
                    <p className="text-sm text-indigo-700 font-medium">{'当前分配至：' + MODES.find(m => m.id === currentMode)?.label}</p>
                  </div>

                  <p className="text-sm text-gray-600 mb-2">点击词汇选中（可多选）：</p>
                  {/* 计算当前方式可用的词汇列表 */}
                  {(() => {
                    const assignedToOtherModes = new Set();
                    if (!allowRepeat) {
                      Object.entries(assignMap).forEach(([mid, ws]) => {
                        if (mid !== currentMode) (ws || []).forEach(w => assignedToOtherModes.add(w));
                      });
                    }
                    const displayWords = allowRepeat ? words : words.filter(w => !assignedToOtherModes.has(w));
                    return (
                      <div className="flex flex-wrap gap-2 mb-4">
                        {displayWords.map((word, i) => {
                          const isSelected = selectedWords.includes(word);
                          const isAssigned = (assignMap[currentMode] || []).includes(word);
                          return (
                            <button
                              key={i}
                              onClick={() => toggleWord(word)}
                              className={'px-3 py-2 rounded-lg text-sm border-2 transition ' + (isSelected ? 'border-indigo-500 bg-indigo-100 text-indigo-700' : isAssigned ? 'border-green-400 bg-green-50 text-green-700' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400')}
                            >
                              {(isAssigned ? '✓ ' : '') + word}
                            </button>
                          );
                        })}
                        {displayWords.length === 0 && (
                          <p className="text-xs text-gray-400">暂无可用词汇，请切换到其他方式分配</p>
                        )}
                      </div>
                    );
                  })()}

                  <button
                    onClick={assignToMode}
                    disabled={selectedWords.length === 0}
                    className="w-full py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition font-medium disabled:opacity-50 mb-4"
                  >
                    {'分配到「' + MODES.find(m => m.id === currentMode)?.label + '」(' + selectedWords.length + ' 个词汇)'}
                  </button>

                  {/* 已分配预览 */}
                  <div className="space-y-3">
                    <p className="text-sm font-medium text-gray-700">已分配情况：</p>
                    {selectedModes.map(modeId => {
                      const mode = MODES.find(m => m.id === modeId);
                      const modeWords = assignMap[modeId] || [];
                      return (
                        <div key={modeId} className="bg-gray-50 p-3 rounded-lg">
                          <p className="text-sm font-medium text-gray-700 mb-2">{mode.label + '（' + modeWords.length + ' 个词汇）'}</p>
                          <div className="flex flex-wrap gap-1">
                            {modeWords.map((w, i) => (
                              <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-gray-200 rounded text-xs">
                                {w}
                                <button onClick={() => removeWord(w, modeId)} className="text-red-400 hover:text-red-600 ml-1">&times;</button>
                              </span>
                            ))}
                            {modeWords.length === 0 && <span className="text-xs text-gray-400">暂无分配</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Step 4 */}
              {step === 4 && (
                <div>
                  <h3 className="text-lg font-bold text-gray-800 mb-4">④ 确认房间信息</h3>

                  {/* 校验提示 */}
                  {(() => {
                    const modesWithNoWords = selectedModes.filter(m => (assignMap[m] || []).length === 0);
                    const unassignedWords = allowRepeat ? [] : words.filter(w => {
                      return !selectedModes.some(m => (assignMap[m] || []).includes(w));
                    });
                    const totalAssigned = Object.values(assignMap).reduce((sum, ws) => sum + (ws || []).length, 0);
                    if (modesWithNoWords.length > 0 || unassignedWords.length > 0) {
                      return (
                        <div className="bg-amber-50 border border-amber-200 p-4 rounded-lg mb-4">
                          {modesWithNoWords.length > 0 && (
                            <p className="text-sm text-amber-700 mb-2">⚠️ 以下练习方式尚未分配词汇，请返回步骤③分配：</p>
                          )}
                          {modesWithNoWords.map(m => {
                            const mode = MODES.find(mm => mm.id === m);
                            return <p key={m} className="text-sm text-amber-800">• {mode?.label}</p>;
                          })}
                          {!allowRepeat && unassignedWords.length > 0 && (
                            <div className="mt-2">
                              <p className="text-sm text-amber-700 mb-1">⚠️ 以下 {unassignedWords.length} 个词汇尚未分配到任何方式（将不会生成练习题）：</p>
                              <div className="max-h-24 overflow-y-auto bg-amber-100 rounded p-2">
                                <p className="text-xs text-amber-800">{unassignedWords.join(', ')}</p>
                              </div>
                              <p className="text-xs text-gray-500 mt-1">已分配 {totalAssigned}/{words.length} 个词汇</p>
                            </div>
                          )}
                        </div>
                      );
                    }
                    return null;
                  })()}

                  <div className="space-y-4">
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <p className="text-sm text-gray-500 mb-1">词汇总数</p>
                      <p className="text-2xl font-bold text-indigo-600">{words.length}</p>
                    </div>
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <p className="text-sm text-gray-500 mb-2">练习方式</p>
                      {selectedModes.map(modeId => {
                        const mode = MODES.find(m => m.id === modeId);
                        return (
                          <div key={modeId} className="mb-2">
                            <p className="text-sm font-medium text-gray-700">{mode.label}</p>
                            <p className="text-xs text-gray-500">{'词汇数：' + (assignMap[modeId] || []).length}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 底部按钮 */}
            <div className="sticky bottom-0 bg-white border-t border-gray-200 p-6 rounded-b-2xl flex justify-between items-center">
              {step > 1 ? (
                <button onClick={wizardBack} className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition">
                  上一步
                </button>
              ) : <div></div>}
              {step < 4 ? (
                <button onClick={wizardNext} className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition font-medium">
                  下一步
                </button>
              ) : (() => {
                const totalAssigned = Object.values(assignMap).reduce((sum, ws) => sum + (ws || []).length, 0);
                const canCreate = totalAssigned > 0;
                return (
                  <button onClick={handleCreateRoom} disabled={creating || !canCreate} className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium disabled:opacity-50">
                    {creating ? '创建中...' : (totalAssigned < words.length ? '✓ 创建房间（仅生成已分配词汇的题目）' : '✓ 创建房间')}
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
