import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect, Component } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../api';
import { getToken } from '../auth';
import { MODES, modeLabel, modeDesc } from '../modes';

/* ── 工具函数 ── */
function fullSentence(q) {
  if (!q) return '';
  return (q.sentence || '').replace(/_{4,}/, q.correct_answer || q.word || '');
}
// 原句截断：最长 maxWords 个单词（空白 ______ 计 1 个词），超长则从较长一侧在逗号/连词处自然切断，保留空白
function truncateSentenceForSearch(sentence, maxWords = 15) {
  if (!sentence) return sentence;
  const words = sentence.split(/\s+/).filter(Boolean);
  const isBlank = w => /_{4,}/.test(w);
  const isWord = w => /[A-Za-z]/.test(w) || isBlank(w); // 真实单词或空白都计 1 词
  const total = words.filter(isWord).length;
  if (total <= maxWords) return sentence;
  const CONN = ['and', 'but', 'or', 'nor', 'for', 'yet', 'so', 'because', 'although', 'though', 'while', 'which', 'that', 'when', 'where', 'if', 'unless', 'once', 'since', 'after', 'before'];
  const bareWord = w => w.replace(/[^A-Za-z]/g, '').toLowerCase();
  const isBoundary = w => /[,;]$/.test(w) || CONN.includes(bareWord(w));
  const blankIdx = words.findIndex(isBlank);
  if (blankIdx < 0) {
    let cnt = 0, cut = -1;
    for (let i = 0; i < words.length; i++) { if (/[A-Za-z]/.test(words[i])) cnt++; if (cnt === maxWords) { cut = i; break; } }
    if (cut < 0 || cut >= words.length - 1) return sentence;
    let best = cut;
    for (let i = cut; i >= Math.max(0, cut - 5); i--) { if (isBoundary(words[i])) { best = i; break; } }
    return words.slice(0, best + 1).join(' ').replace(/[,;:]\s*$/, '') + ' …';
  }
  let start = 0, end = words.length - 1;
  const windowCount = () => words.slice(start, end + 1).filter(isWord).length;
  let guard = 0;
  while (windowCount() > maxWords && guard++ < words.length + 5) {
    const before = words.slice(start, blankIdx + 1).filter(isWord).length;
    const after = words.slice(blankIdx, end + 1).filter(isWord).length;
    if (before >= after) {
      let i = start;
      while (i < blankIdx) { if (isBoundary(words[i])) break; i++; }
      start = Math.min(i + 1, blankIdx);
    } else {
      let i = end;
      while (i > blankIdx) { if (isBoundary(words[i])) break; i--; }
      end = Math.max(i - 1, blankIdx);
    }
  }
  return words.slice(start, end + 1).join(' ');
}
function correctDef(q) {
  if (q.definition) return q.definition;
  const i = (q.options || []).indexOf(q.correct_answer);
  return i >= 0 && q.option_defs && q.option_defs[i] ? q.option_defs[i] : '';
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z\s-]/g, '').replace(/\s+/g, ' ').trim();
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// 正则转义（前端用）
function escapeReg(s) {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ── 拼写听写工具 ── */
// Levenshtein 编辑距离：用于拼写容错判断
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// 拼写容错判定：错/漏/多字母 ≤ 阈值即算正确（阈值 = max(3, 词长×15%)）
function isSpellingAcceptable(input, target) {
  if (!input) return false;
  const dist = levenshtein(input.trim(), target);
  const threshold = Math.max(3, Math.ceil(target.length * 0.15));
  return dist <= threshold;
}

// 生成首字母提示占位符：如 "paranoid" → "p______d"，"look forward to" → "l_ f_____ t_"
function firstLetterHint(word) {
  if (!word) return '';
  const parts = word.split(/\s+/);
  return parts.map(p => {
    if (p.length <= 1) return p;
    return p[0] + '_'.repeat(p.length - 1);
  }).join(' ');
}

// 发音朗读（Web Speech API）
function speakWord(word) {
  if (!word || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  u.rate = 0.85;
  window.speechSynthesis.speak(u);
}

/* ── 语块分词器（组词成句用：把句子拆成语块/意群，而非单个词） ── */
const DETERMINERS = new Set(['a','an','the','this','that','these','those','my','your','his','her','its','our','their','some','any','no','every','each','all','both','few','many','much','other','another','such','what','which','who','whom','whose']);
const PREPOSITIONS = new Set(['in','on','at','to','from','with','by','for','of','about','into','through','during','before','after','above','below','between','under','against','without','within','along','across','behind','beside','around','among','towards','upon','despite','except','beyond','via','plus','minus','per','versus','regarding','concerning','given','following','including','unlike','near','off','out','over','past','since','until','up','down']);
const AUXILIARIES = new Set(['am','is','are','was','were','be','been','being','will','would','shall','should','can','could','may','might','must','need','dare','ought','has','have','had','do','does','did','ll','ve','re','s']);
const ADVERBS = new Set(['not','never','always','usually','often','sometimes','rarely','seldom','hardly','ever','just','only','even','also','still','already','yet','once','twice','here','there','now','then','today','tomorrow','yesterday','away','back','well','very','really','quite','rather','too','so','more','most','less','least','much','especially','particularly','increasingly','constantly','frequently','generally','typically','actually','basically','clearly','obviously','simply','merely','purely','ultimately','eventually','finally','originally','previously','currently','recently','commonly','widely','mainly','largely','partially','fully','completely','totally','entirely','absolutely','definitely','certainly','probably','possibly','perhaps','maybe','certain','sure','likely','unlikely']);
const CONJUNCTIONS = new Set(['and','but','or','nor','for','yet','so','although','though','because','if','when','while','whereas','whether','unless','until','once','since','as','after','before','that','which','who','whom','whose']);

function chunkSentence(sentence) {
  // 1. 保留标点附着到前一个词上；逗号/句号作为独立停顿标记
  const raw = sentence.split(/\s+/).filter(Boolean);
  const words = raw.map(w => {
    const m = w.match(/^([\w'-]+)([.,!?;:'"]*)$/);
    return m ? { word: m[1], punct: m[2], hasComma: m[2].includes(',') } : { word: w, punct: '', hasComma: false };
  });

  // 辅助：从位置 pos 向前扫描，遇到逗号就停（防止跨子句）
  const untilComma = (start, max) => {
    let e = start;
    while (e < max && !words[e].hasComma) e++;
    return Math.min(e, max);
  };

  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i].word.toLowerCase();
    const punct = words[i].punct;
    const limit = untilComma(i + 1, words.length);

    // 规则1：限定词 + 形容词(们) + 名词 → 一个语块（如 "a balanced diet", "many young people"）
    if (DETERMINERS.has(w) || ['many','much','few','several','all','both','some','any'].includes(w)) {
      let j = i + 1;
      while (j < limit) {
        const nw = words[j].word.toLowerCase();
        if (ADVERBS.has(nw) || AUXILIARIES.has(nw) || CONJUNCTIONS.has(nw) || PREPOSITIONS.has(nw)) break;
        if (j > i + 1 && (AUXILIARIES.has(nw) || nw.match(/^(ing|ed|s)$/))) break;
        j++;
      }
      if (j <= i + 1 && i + 1 < limit) j = i + 2;
      else if (j === i + 1) j = i + 1;
      chunks.push(words.slice(i, j).map(x => x.word).join(' ') + punct);
      i = j; continue;
    }

    // 规则2：介词短语 → 介词 + 后续名词/形容词（如 "with knowing", "to checking"）
    if (PREPOSITIONS.has(w) || w === 'to') {
      let j = i + 1;
      while (j < limit) {
        const nw = words[j].word.toLowerCase();
        if (CONJUNCTIONS.has(nw) || (AUXILIARIES.has(nw) && j > i + 1)) break;
        if (PREPOSITIONS.has(nw) && j > i + 1) break;
        j++;
      }
      if (j <= i + 1 && i + 1 < limit) j = i + 2;
      else if (j === i + 1) j = i + 1;
      chunks.push(words.slice(i, j).map(x => x.word).join(' ') + punct);
      i = j; continue;
    }

    // 规则3：助动词/情态动词 + 主要动词/副词+动词（如 "can be", "will pursue", "are constantly checking"）
    if (AUXILIARIES.has(w)) {
      let j = i + 1;
      while (j < limit && (AUXILIARIES.has(words[j].word.toLowerCase()) || ADVERBS.has(words[j].word.toLowerCase()))) j++;
      if (j < limit) j++; // 吃掉主要动词
      if (j <= i + 1 && i + 1 < limit) j = i + 2;
      chunks.push(words.slice(i, j).map(x => x.word).join(' ') + punct);
      i = j; continue;
    }

    // 规则4：副词 → 单独成块（不贪吃下一个词，避免 "more in" 这类错误）
    if (ADVERBS.has(w)) {
      chunks.push(words[i].word + punct); i++; continue;
    }

    // 规则5：从属连词 + 主语开头（如 "Although it", "because they"）
    if (CONJUNCTIONS.has(w) && !['and','but','or'].includes(w)) {
      const j = i + 2 <= limit ? i + 2 : i + 1;
      chunks.push(words.slice(i, j).map(x => x.word).join(' ') + punct);
      i = j; continue;
    }

    // 默认：单独成块
    chunks.push(words[i].word + punct);
    i++;
  }
  return chunks.filter(c => c.trim());
}

/* ── 粗粒度语块分词器（拖曳语块成句用：把句子拆成 4~5 个语块） ── */
// 在逗号 / 连词处优先断开，再合并或拆分，使最终语块数落在 [minN, maxN] 区间。
function splitIntoChunks(sentence, minN = 4, maxN = 5) {
  const raw = (sentence || '').trim().split(/\s+/).filter(Boolean);
  if (raw.length === 0) return [];
  const words = raw.map(w => {
    const m = w.match(/^([\w'-]+)([.,!?;:'"]*)$/);
    return m ? { word: m[1], punct: m[2] } : { word: w, punct: '' };
  });
  const breaks = new Set();
  for (let i = 0; i < words.length; i++) {
    if (words[i].punct.includes(',')) breaks.add(i);          // 逗号后断开
    if (i > 0 && CONJUNCTIONS.has(words[i].word.toLowerCase())) breaks.add(i - 1); // 连词前断开
  }
  // 初始分段
  let segs = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]);
    if (breaks.has(i) && i < words.length - 1) { segs.push(cur); cur = []; }
  }
  if (cur.length) segs.push(cur);
  if (segs.length === 0) return [];
  // 太多 → 合并相邻最短的两段，直到 ≤ maxN
  while (segs.length > maxN) {
    let bi = 0, bl = Infinity;
    for (let i = 0; i < segs.length - 1; i++) {
      const len = segs[i].length + segs[i + 1].length;
      if (len < bl) { bl = len; bi = i; }
    }
    segs[bi] = segs[bi].concat(segs[bi + 1]);
    segs.splice(bi + 1, 1);
  }
  // 太少 → 在最长段的中点（优先靠近连词/空格）拆开，直到 ≥ minN
  while (segs.length < minN && segs.some(s => s.length >= 2)) {
    let li = 0, ll = -1;
    for (let i = 0; i < segs.length; i++) if (segs[i].length > ll) { ll = segs[i].length; li = i; }
    const seg = segs[li];
    let mid = Math.floor(seg.length / 2);
    // 尽量在连词处断开，让拆分更自然
    for (let k = mid; k < seg.length - 1; k++) {
      if (CONJUNCTIONS.has(seg[k].word.toLowerCase())) { mid = k; break; }
    }
    segs.splice(li, 1, seg.slice(0, mid), seg.slice(mid));
  }
  return segs.map(seg => seg.map(x => x.word + x.punct).join(' '));
}

// 通用干扰词池（词格找句用，避免网格太空）
const COMMON_DISTRACTORS = [
  'the','and','that','this','with','from','they','will','would','there','their','about','which','when','what','have','has','been','were','are','was','said','each','more','some','time','year','people','world','school','water','money','house','place','city','child','study','work','life','book','word','story','idea','issue','group','part','system','number','fact','case','point','level','kind','head','hand','day','way','man','woman','friend','home','food','health','power','light','music','game','name','line','end','mind','heart','sound','color','tree','bird','fish','star','moon','wind','rain','snow','fire','road','door','wall','floor','table','chair','paper','pen','eye','ear','mouth','face','voice'
];

// 词格找句：生成「单词网格」，把句子作为一条直线路径藏进去
function generateWordGrid(words, distractors) {
  const n = Math.min(words.length, 12); // 6x6最多放12词，留24格干扰词，保证完整句子
  const size = 6; // 固定6x6
  const allDirs = [[0,1],[1,0],[0,-1],[-1,0]]; // 仅上下左右，去对角线
  
  // 蛇形路径：起点随机，每步随机选相邻方向（可以转弯）
  function trySnakePath() {
    const path = [];
    const used = new Set();
    const r0 = Math.floor(Math.random() * size);
    const c0 = Math.floor(Math.random() * size);
    path.push({ r: r0, c: c0 });
    used.add(`${r0},${c0}`);
    for (let i = 1; i < n; i++) {
      const last = path[path.length - 1];
      // 随机打乱方向，优先找未使用的相邻格
      const shuffled = shuffle([...allDirs]);
      let found = false;
      for (const [dr, dc] of shuffled) {
        const nr = last.r + dr, nc = last.c + dc;
        if (nr >= 0 && nr < size && nc >= 0 && nc < size && !used.has(`${nr},${nc}`)) {
          path.push({ r: nr, c: nc });
          used.add(`${nr},${nc}`);
          found = true;
          break;
        }
      }
      if (!found) return null;
    }
    return path;
  }
  
  let path = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    path = trySnakePath();
    if (path) break;
  }
  // 兜底：直线横放
  if (!path) {
    path = words.slice(0, n).map((_, i) => ({ r: Math.floor(i / size), c: i % size }));
  }
  
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  words.slice(0, n).forEach((w, i) => { const { r, c } = path[i]; grid[r][c] = w; });
  const empties = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (grid[r][c] === null) empties.push({ r, c });
  shuffle(empties);
  let di = 0;
  const pool = distractors.length ? distractors : COMMON_DISTRACTORS;
  empties.forEach(e => { grid[e.r][e.c] = pool[di++ % pool.length]; });
  return { grid, size, path };
}

// 形近辨析：把目标词(多次) + 形近干扰词(多次) 分散散布到网格（目标词强制跨行）
function generateLookalikeGrid(target, confusers) {
  const tCount = 3, cCount = 2;
  // 构建单元格池
  const cells = [];
  for (let i = 0; i < tCount; i++) cells.push(target);
  (confusers || []).forEach(c => { for (let i = 0; i < cCount; i++) cells.push(c); });
  let size = Math.ceil(Math.sqrt(cells.length));
  while (cells.length < size * size) cells.push(confusers && confusers.length ? confusers[Math.floor(Math.random() * confusers.length)] : target);

  // 先创建空网格
  const grid = [];
  for (let r = 0; r < size; r++) grid.push(new Array(size).fill(null));
  const totalCells = size * size;

  // 第 1 步：将目标词分散放到不同行（每行最多 1 个目标词）
  const targetPositions = [];
  const rows = [...Array(size).keys()];
  shuffle(rows);
  for (let i = 0; i < tCount && i < size; i++) {
    const r = rows[i];
    let c;
    do { c = Math.floor(Math.random() * size); } while (grid[r][c] !== null);
    grid[r][c] = target;
    targetPositions.push(r * size + c);
  }

  // 第 2 步：收集剩余空位，用干扰词 + 剩余目标词（如有）填满并随机打乱
  const remaining = [];
  const usedSet = new Set(targetPositions);
  for (let i = 0; i < totalCells; i++) if (!usedSet.has(i)) remaining.push(i);
  // 填充内容：非目标位置全部用干扰词或重复目标
  const fillerPool = [];
  (confusers || []).forEach(c => { for (let i = 0; i < cCount; i++) fillerPool.push(c); });
  while (fillerPool.length < remaining.length) {
    fillerPool.push(confusers && confusers.length ? confusers[Math.floor(Math.random() * confusers.length)] : target);
  }
  shuffle(fillerPool);
  remaining.forEach((pos, i) => {
    const r = Math.floor(pos / size), c = pos % size;
    grid[r][c] = fillerPool[i];
  });

  return { grid, size, total: tCount };
}

// ABCD 选项网格（填空：先选高亮，再点「确定答案」提交）
function OptionGrid({ q, selectedWord, isCorrect, onSelect }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {q.options.map((opt, i) => {
        let cls = 'border rounded-lg text-left transition text-sm ';
        const isRight = opt === q.correct_answer;
        const isWrongSel = opt === selectedWord && !isCorrect;
        const isSelected = opt === selectedWord && isCorrect === null;
        if (isCorrect !== null) {
          if (isRight) cls += 'border-green-400 bg-green-50 text-green-800';
          else if (isWrongSel) cls += 'border-red-400 bg-red-50 text-red-800';
          else cls += 'border-gray-100 bg-gray-50 text-gray-400';
        } else if (isSelected) {
          cls += 'border-indigo-400 bg-indigo-50 text-indigo-800 font-medium';
        } else {
          cls += 'border-gray-200 hover:border-indigo-300 active:bg-indigo-50';
        }
        return (
          <button key={i} onClick={() => onSelect(opt)} disabled={isCorrect !== null} className={'py-2.5 px-3 ' + cls}>
            <span className="text-gray-300 mr-1.5 text-xs">{String.fromCharCode(65 + i)}.</span><span className="font-medium">{opt}</span>
            {selectedWord !== null && <div className="text-[10px] mt-1 opacity-70">{(q.option_defs && q.option_defs[i]) ? (isRight ? '✓ ' : '') + q.option_defs[i] : ''}</div>}
          </button>
        );
      })}
    </div>
  );
}

// ── 翻卡牌：记忆配对组件（独立于逐题流程）──
function MemoryMatch({ words, onDone }) {
  // 把每个词拆成一对 [en卡, cn卡]
  // 根据词量决定网格大小（尽量接近正方形）
  const n = words.length;
  // 目标对数：至少 6 对最多 12 对；若词不够就重复使用
  const targetPairs = Math.max(6, Math.min(12, n));
  // 凑够目标对数
  let pool = [...words];
  while (pool.length < targetPairs) pool.push(words[pool.length % words.length]);
  pool = pool.slice(0, targetPairs);

  const pairs = pool.map((w, idx) => ({
    pairId: idx,
    word: w.word,
    en: w.word,
    cn: correctDef(w) || w.chinese || w.definition || '(释义)',
    enCard: { type: 'en', pairId: idx, label: w.word },
    cnCard: { type: 'cn', pairId: idx, label: correctDef(w) || w.chinese || w.definition || '?' },
  }));

  // 打乱后的卡片数组（每对两张）
  const [cards, setCards] = useState(() =>
    shuffle([...pairs.flatMap(p => [
      { ...p.enCard, id: p.pairId + '_en' },
      { ...p.cnCard, id: p.pairId + '_cn' }
    ])])
  );
  const [flipped, setFlipped] = useState([]);       // 已翻开但未匹配的 card id 列表
  const [matched, setMatched] = useState(new Set()); // 已匹配的 pairId 集合
  const [checking, setChecking] = useState(false);   // 等待翻回动画中
  const movesRef = useRef(0);

  // 计算网格列数（尽量接近正方形）
  const totalCards = cards.length;
  const cols = totalCards <= 12 ? 3 : totalCards <= 20 ? 4 : totalCards <= 30 ? 5 : 6;

  useEffect(() => {
    if (matched.size === pairs.length && pairs.length > 0) {
      onDone({ totalPairs: pairs.length, moves: movesRef.current });
    }
  }, [matched.size]);

  function flip(cardIdx) {
    if (checking) return;
    const c = cards[cardIdx];
    if (matched.has(c.pairId)) return;
    if (flipped.includes(c.id)) return;

    if (flipped.length >= 1) {
      // 已经翻开了一张，这是第二张
      const first = cards.find(x => x.id === flipped[0]);
      const newFlipped = [...flipped, c.id];
      setFlipped(newFlipped);
      setChecking(true);
      movesRef.current++;

      if (first.pairId === c.pairId) {
        // 匹配成功！
        setTimeout(() => {
          setMatched(prev => new Set(prev).add(c.pairId));
          setFlipped([]);
          setChecking(false);
        }, 500);
      } else {
        // 不匹配，翻回
        setTimeout(() => {
          setFlipped([]);
          setChecking(false);
        }, 900);
      }
    } else {
      // 第一张
      setFlipped([c.id]);
    }
  }

  return (
    <div>
      <p className="text-[11px] text-center text-indigo-500 mb-2">
        配对记忆 · 找出匹配的中英文 · 已完成 {matched.size}/{pairs.length} 对
      </p>
      {/* 卡片网格 */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '8px' }}>
        {cards.map((c, idx) => {
          const isFaceUp = flipped.includes(c.id) || matched.has(c.pairId);
          const isMatched = matched.has(c.pairId);
          return (
            <button key={c.id} onClick={() => flip(idx)}
              disabled={checking || isMatched}
              style={{
                aspectRatio: '1',
                borderRadius: '8px',
                border: isMatched ? '2px solid #16a34a' : '1px solid #d1d5db',
                background: isFaceUp ? '#fff' : '#4f46e5',
                color: isFaceUp ? (c.type === 'en' ? '#1f2937' : '#059669') : '#fff',
                fontSize: c.type === 'en' ? '13px' : '11px',
                fontWeight: c.type === 'en' ? '700' : '500',
                padding: '6px 4px',
                cursor: (checking || isMatched) ? 'default' : 'pointer',
                transition: 'transform 0.25s, background 0.25s',
                transform: isFaceUp ? '' : '',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                lineHeight: '1.2',
                overflow: 'hidden',
                wordBreak: 'break-word',
                userSelect: 'none',
              }}
            >
              {!isFaceUp ? (
                <span style={{ opacity: 0.7 }}>?</span>
              ) : (
                c.label
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── 连线题：左词右义，测量真实坐标后画连线 ── */
function MatchMode({ q, initialResult, onCommit, onSolved }) {
  const opts = q.options || [];
  const defs = q.option_defs || opts.map(o => `"${o}"`);
  const n = opts.length;

  const [leftSel, setLeftSel] = useState(null);
  const [pairs, setPairs] = useState({});   // leftIdx -> rightIdx
  const [checked, setChecked] = useState(false);
  const [isCorrect, setIsCorrect] = useState(null);
  const [showCorrections, setShowCorrections] = useState(false);

  // 还原已答状态
  useEffect(() => {
    if (initialResult) {
      const sa = initialResult.student_answer;
      setPairs(typeof sa === 'object' && sa ? sa : {});
      setChecked(true);
      setIsCorrect(initialResult.is_correct);
    } else {
      setPairs({}); setChecked(false); setIsCorrect(null); setLeftSel(null);
    }
    // eslint-disable-next-line
  }, [q?.uid]);

  // 右侧释义顺序：基于 uid 的稳定种子打乱（与左侧顺序相互独立）
  const rightOrder = useMemo(() => {
    const base = (q.uid || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const arr = defs.map((_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = ((base + i * 31) % (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
    // eslint-disable-next-line
  }, [q?.uid]);

  const leftItems = opts.map((w, i) => ({ word: w, idx: i }));
  const rightItems = rightOrder.map(ri => ({ def: defs[ri], origIdx: ri }));

  // 测量真实坐标画线
  const areaRef = useRef(null);
  const leftRefs = useRef([]);
  const rightRefs = useRef([]);
  const [lines, setLines] = useState([]);

  const recompute = useCallback(() => {
    const area = areaRef.current;
    if (!area) return;
    const ar = area.getBoundingClientRect();
    const out = [];
    for (const li of Object.keys(pairs)) {
      const ri = pairs[li];
      const lb = leftRefs.current[li];
      const rb = rightRefs.current[ri];
      if (!lb || !rb) continue;
      const lr = lb.getBoundingClientRect();
      const rr = rb.getBoundingClientRect();
      out.push({
        x1: lr.right - ar.left,
        y1: lr.top + lr.height / 2 - ar.top,
        x2: rr.left - ar.left,
        y2: rr.top + rr.height / 2 - ar.top,
        correct: checked && Number(li) === Number(ri),
      });
    }
    setLines(out);
  }, [pairs, checked, q?.uid]);

  useLayoutEffect(() => { recompute(); }, [recompute]);
  useEffect(() => {
    const h = () => recompute();
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, [recompute]);

  const clickLeft = (idx) => {
    if (checked) return;
    // 再次点击已连线项 → 取消连线
    if (String(idx) in pairs) { unpair(idx); return; }
    setLeftSel(idx);
  };
  const clickRight = (ri) => {
    if (checked) return;
    // 点击已被连的右侧 → 取消该条连线
    const existingLeft = Object.keys(pairs).find(k => pairs[k] === ri);
    if (existingLeft !== undefined && leftSel === null) { unpair(existingLeft); return; }
    if (leftSel === null) return;
    const np = { ...pairs };
    if (existingLeft !== undefined) delete np[existingLeft];
    np[leftSel] = ri;
    setPairs(np);
    setLeftSel(null);
  };
  const unpair = (li) => {
    if (checked) return;
    const np = { ...pairs }; delete np[li]; setPairs(np);
  };
  const check = () => {
    if (checked || Object.keys(pairs).length !== n) return;
    let allC = true;
    for (const li of Object.keys(pairs)) if (Number(li) !== Number(pairs[li])) allC = false;
    setChecked(true); setIsCorrect(allC);
    onCommit(allC, pairs);
    onSolved && onSolved(allC);
  };
  return (
    <div className="relative" ref={areaRef}>
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: 'visible' }}>
        {lines.map((l, i) => (
          <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke={l.correct ? '#16a34a' : checked ? '#dc2626' : '#6366f1'}
            strokeWidth="2" strokeDasharray={checked ? '0' : '4,3'} />
        ))}
      </svg>

      <div className="flex gap-3 items-stretch">
        {/* 左列：单词 */}
        <div className="flex-1 space-y-2">
          {leftItems.map(item => {
            const connected = String(item.idx) in pairs;
            const isSel = leftSel === item.idx;
            const isRightFinal = checked && item.idx === Number(pairs[item.idx]);
            const isWrongFinal = checked && String(item.idx) in pairs && item.idx !== Number(pairs[item.idx]);
            let bg = 'bg-white border-gray-200 hover:border-indigo-300';
            if (isSel) bg = 'bg-indigo-50 border-indigo-400 ring-1 ring-indigo-300';
            else if (isRightFinal) bg = 'bg-green-50 border-green-400';
            else if (isWrongFinal) bg = 'bg-red-50 border-red-300';
            else if (connected) bg = 'bg-gray-50 border-gray-300';
            return (
              <button key={item.idx} ref={el => (leftRefs.current[item.idx] = el)}
                onClick={() => clickLeft(item.idx)}
                disabled={checked}
                className={'w-full text-left px-3 py-2.5 rounded-lg border text-sm font-medium transition truncate '
                  + (connected && !checked ? 'cursor-pointer hover:border-red-300 hover:bg-red-50/50 ' : 'cursor-pointer ') + bg}>
                <span className="inline-block w-4 h-4 rounded-full text-[10px] leading-4 text-center mr-1.5 shrink-0"
                  style={{ backgroundColor: connected ? (isRightFinal ? '#16a34a' : isWrongFinal ? '#dc2626' : '#6366f1') : '#e5e7eb', color: connected ? '#fff' : '#9ca3af' }}>
                  {connected ? (isRightFinal ? '✓' : checked ? '✗' : '✓') : item.idx + 1}
                </span>
                {item.word}
              </button>
            );
          })}
        </div>

        <div className="w-6" />

        {/* 右列：释义 */}
        <div className="flex-1 space-y-2">
          {rightItems.map((item, vi) => {
            const connectedLeft = Object.keys(pairs).find(k => pairs[k] === item.origIdx);
            const isTargeted = leftSel !== null && !checked;
            let bg = 'bg-white border-gray-200';
            if (connectedLeft !== undefined) {
              const li = Number(connectedLeft);
              bg = checked ? (li === item.origIdx ? 'bg-green-50 border-green-400' : 'bg-red-50 border-red-300') : 'bg-indigo-50 border-indigo-300';
            } else if (isTargeted) bg = 'bg-yellow-50 border-yellow-300';
            return (
              <button key={vi} ref={el => (rightRefs.current[item.origIdx] = el)}
                onClick={() => clickRight(item.origIdx)}
                disabled={checked}
                className={'w-full text-left px-2.5 py-2 rounded-lg border text-[11px] leading-snug transition '
                  + (connectedLeft !== undefined && !checked ? 'cursor-pointer hover:border-red-300 hover:bg-red-50/50 ' : 'hover:border-indigo-300 cursor-pointer ') + bg}>
                <span className="text-[10px] text-gray-400 mr-1">{String.fromCharCode(65 + vi)}.</span>
                {item.def}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <span className="text-[10px] text-gray-400 flex-1 self-center">
          已连 {Object.keys(pairs).length}/{n} · {checked ? '' : (leftSel !== null ? '点击右侧释义完成配对' : '点左侧单词再点右侧释义')}
        </span>
        {!checked && (
          <button onClick={check} disabled={Object.keys(pairs).length < n}
            className={'py-2 px-4 text-xs rounded font-medium ' + (Object.keys(pairs).length >= n ? 'bg-gray-800 text-white hover:bg-gray-700' : 'bg-gray-100 text-gray-400 cursor-default')}>
            检查连线 ({Object.keys(pairs).length}/{n})
          </button>
        )}
      </div>

      {!checked && (
        <div className="mt-1 text-[10px] text-gray-400">
          提示：再次点击已连线的单词或释义可取消该条连线
        </div>
      )}

      {checked && (
        <div className={'mt-3 px-3 py-2 rounded text-xs text-center ' + (isCorrect ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700')}>
          {isCorrect ? '✓ 全部正确！' : `✗ 有 ${Object.values(pairs).filter((ri) => { const li = Object.keys(pairs).find(k => pairs[k] === ri); return Number(li) !== Number(ri); }).length} 条连线错误`}
        </div>
      )}

      {/* 错误修正：只显示错误项的正确答案 */}
      {checked && !isCorrect && (() => {
        const wrongItems = Object.keys(pairs)
          .map(li => ({ li: Number(li), wrongRi: pairs[li] }))
          .filter(({ li, wrongRi }) => li !== Number(wrongRi));
        return (
          <div className="mt-2">
            <button onClick={() => setShowCorrections(v => !v)}
              className={'text-[10px] px-2 py-1 rounded border transition ' + (showCorrections ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'bg-gray-50 border-gray-200 text-gray-500 hover:border-indigo-200 hover:text-indigo-500')}>
              {showCorrections ? '▲ 收起修正' : `📝 查看 ${wrongItems.length} 处错误修正`}
            </button>
            {showCorrections && (
              <div className="mt-2 space-y-1.5">
                {wrongItems.map(({ li, wrongRi }) => (
                  <div key={li} className="border border-red-200 bg-red-50/50 rounded px-2.5 py-2 text-[11px] leading-relaxed">
                    <span className="font-semibold text-gray-800">{opts[li]}</span>
                    <span className="text-gray-300 mx-1">→</span>
                    <span className="text-red-500 line-through">{defs[wrongRi]}</span>
                    <br />
                    <span className="text-green-600 font-medium">✓ {defs[li]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

/* ── 搭配拼词：⑨ Collocation ── */
function CollocationBuilder({ q, initialResult, onCommit, onSolved }) {
  const [picked, setPicked] = useState(null);
  const [isCorrect, setIsCorrect] = useState(null);
  useEffect(() => {
    if (initialResult) { setPicked(initialResult.student_answer); setIsCorrect(initialResult.is_correct); }
    else { setPicked(null); setIsCorrect(null); }
  }, [q?.uid]); // eslint-disable-line

  const hint = (q.sentence || '').replace(new RegExp('\\b' + escapeReg(q.correct_answer) + '\\b', 'i'), '______');

  const select = (opt) => {
    if (isCorrect !== null) return;
    setPicked(prev => (prev === opt ? null : opt)); // 再点同一项取消
  };
  const confirm = () => {
    if (picked === null || isCorrect !== null) return;
    const correct = picked === q.correct_answer;
    setIsCorrect(correct);
    onCommit(correct, picked, q.correct_answer);
    onSolved(correct);
  };

  return (
    <div>
      <p className="text-[11px] text-indigo-500 mb-1">搭配拼词 · 选出能组成地道搭配的词</p>
      <p className="text-2xl font-bold text-gray-800 mb-1">{q.word} <span className="text-gray-300">+</span> ______</p>
      {q.chinese && <p className="text-xs text-gray-400 mb-3">{q.chinese}</p>}
      <p className="text-xs text-gray-500 mb-3 bg-gray-50 rounded px-2 py-1.5 leading-relaxed">{hint}</p>
      <div className="grid grid-cols-2 gap-2">
        {q.options.map((opt, i) => {
          let cls = 'border rounded-lg text-left transition text-sm px-3 py-2.5 ';
          const isRight = opt === q.correct_answer;
          const isWrongSel = picked === opt && !isCorrect;
          const isSelected = picked === opt && isCorrect === null;
          if (isCorrect !== null) {
            if (isRight) cls += 'border-green-400 bg-green-50 text-green-800';
            else if (isWrongSel) cls += 'border-red-400 bg-red-50 text-red-800';
            else cls += 'border-gray-100 bg-gray-50 text-gray-400';
          } else if (isSelected) {
            cls += 'border-indigo-400 bg-indigo-50 text-indigo-800 font-medium';
          } else {
            cls += 'border-gray-200 hover:border-indigo-300 active:bg-indigo-50';
          }
          return <button key={i} onClick={() => select(opt)} disabled={isCorrect !== null} className={cls}>{String.fromCharCode(65 + i)}. {opt}</button>;
        })}
      </div>
      {isCorrect === null && picked !== null && (
        <button onClick={confirm}
          className="mt-3 w-full text-sm bg-indigo-600 text-white py-2.5 rounded-lg hover:bg-indigo-700 font-medium">
          确定答案
        </button>
      )}
      {isCorrect === null && picked === null && (
        <p className="mt-3 text-center text-xs text-gray-400">请选择一个词</p>
      )}
      {isCorrect !== null && (
        <div className={'mt-3 px-3 py-2 rounded text-xs ' + (isCorrect ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700')}>
          {isCorrect ? `✓ 正确！${q.word} ${q.correct_answer} 是地道搭配` : `✗ 正确答案：${q.word} ${q.correct_answer}`}
        </div>
      )}
    </div>
  );
}

/* ── 词格找句：⑧ Sentence Search ── */
function SentenceSearch({ q, initialResult, onCommit, onSolved, distractorPool }) {
  // 对【原句】q.sentence 做长度限制（空白计 1 词，最长 15 词），再填回答案
  const sentence = fullSentence({ ...q, sentence: truncateSentenceForSearch(q.sentence, 15) });
  const rawWords = sentence.split(/\s+/).map(w => w.replace(/[^A-Za-z']/g, '')).filter(Boolean);
  const target = rawWords;
  const targetKey = target.join(' ').toLowerCase();
  const targetLower = target.map(t => t.toLowerCase());

  const { grid, size, path } = useMemo(() => {
    const pool = (distractorPool || []).map(w => String(w).toLowerCase()).filter(w => !targetLower.includes(w));
    const distract = pool.length >= target.length ? pool : [...pool, ...COMMON_DISTRACTORS];
    return generateWordGrid(target, distract);
  }, [targetKey]); // eslint-disable-line

  const [selected, setSelected] = useState([]);
  const [status, setStatus] = useState(null);
  const [solved, setSolved] = useState(false);
  const [hint1, setHint1] = useState(false);
  const [hint2, setHint2] = useState(false);
  const [hint3, setHint3] = useState(false);
  const [hintCoords, setHintCoords] = useState(''); // SVG polyline points in px
  const [revealed, setRevealed] = useState(false); // 是否点了「显示答案」
  const gridRef = useRef(null);

  useEffect(() => {
    if (initialResult && initialResult.is_correct) { setSelected(path); setStatus('correct'); setSolved(true); setRevealed(false); }
    else if (initialResult && initialResult.student_answer === target.join(' ')) { setSelected(path); setStatus('correct'); setSolved(true); setRevealed(true); }
    else { setSelected([]); setStatus(null); setSolved(false); setRevealed(false); setHint1(false); setHint2(false); setHint3(false); }
  }, [targetKey]); // eslint-disable-line

  // 测量网格格子位置，算SVG虚线穿针坐标（精确像素，解决错位）
  const updateHintCoords = useCallback(() => {
    const activeHint = hint1 || hint2 || hint3;
    if (!activeHint || !gridRef.current) { setHintCoords(''); return; }
    const segSize = Math.ceil(path.length / 3);
    const cells = hint1 ? path.slice(0, segSize)
      : hint2 ? path.slice(segSize, segSize * 2)
      : path.slice(segSize * 2);
    if (cells.length < 2) { setHintCoords(''); return; }
    const gridEl = gridRef.current;
    const cellsEls = gridEl.querySelectorAll('button');
    if (!cellsEls.length) { setHintCoords(''); return; }
    const rect = gridEl.getBoundingClientRect();
    const pts = cells.map(p => {
      const idx = p.r * size + p.c;
      const cell = cellsEls[idx];
      if (!cell) return null;
      const cr = cell.getBoundingClientRect();
      const x = cr.left - rect.left + cr.width / 2;
      const y = cr.top - rect.top + cr.height / 2;
      return `${x},${y}`;
    }).filter(Boolean).join(' ');
    setHintCoords(pts);
  }, [grid, size, path, hint1, hint2]);

  useEffect(() => { updateHintCoords(); }, [updateHintCoords]);
  // 窗口缩放时重算
  useEffect(() => {
    if (!hint1 && !hint2 && !hint3) return;
    const onResize = () => updateHintCoords();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [hint1, hint2, hint3, updateHintCoords]);

  // 仅上下左右相邻（去对角线）
  const adj = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;

  const evaluate = (cells) => {
    const seq = cells.map(c => grid[c.r][c.c]).map(w => w.toLowerCase());
    const tgt = targetLower;
    const rev = [...tgt].reverse();
    const ok = seq.length === tgt.length && (seq.every((w, i) => w === tgt[i]) || seq.every((w, i) => w === rev[i]));
    setStatus(ok ? 'correct' : 'wrong');
    setSolved(true);
    onCommit(ok, cells.map(c => grid[c.r][c.c]).join(' '), target.join(' '));
    onSolved(ok);
    if (!ok) setTimeout(() => { setSelected([]); setStatus(null); setSolved(false); }, 700);
  };

  // 显示答案：自动高亮整条目标句路径（标绿展示），但本题计为「错误」（学生没自己找出来）
  const showAnswer = () => {
    if (solved) return;
    setSelected([...path]);
    setStatus('correct');
    setSolved(true);
    setRevealed(true);
    onCommit(false, path.map(p => grid[p.r][p.c]).join(' '), target.join(' '));
    onSolved(false);
  };

  const clickCell = (r, c) => {
    if (solved) return;
    const exists = selected.some(s => s.r === r && s.c === c);
    if (exists) {
      // 再次点击最后一个已选格 → 撤销
      const last = selected[selected.length - 1];
      if (last.r === r && last.c === c) {
        setSelected(prev => prev.slice(0, -1));
        setStatus(null);
      }
      return;
    }
    if (selected.length === 0) { setSelected([{ r, c }]); setStatus(null); return; }
    const last = selected[selected.length - 1];
    if (!adj(last, { r, c })) { setStatus('wrong'); setTimeout(() => { if (!solved) setStatus(null); }, 350); return; }
    const ns = [...selected, { r, c }];
    setSelected(ns);
    if (ns.length === target.length) evaluate(ns);
  };

  const reset = () => { if (solved) return; setSelected([]); setStatus(null); setHint1(false); setHint2(false); setHint3(false); };

  const showHint = hint1 || hint2 || hint3;
  const hintSvgW = gridRef.current ? gridRef.current.offsetWidth : 300;
  const hintSvgH = gridRef.current ? gridRef.current.offsetHeight : 300;

  return (
    <div>
      <p className="text-[11px] text-indigo-500 mb-1">词格找句 · 点单词连成隐藏的句子</p>
      {q.chinese && <p className="text-xs text-gray-500 mb-2">🔍 提示（中文）：{q.chinese}</p>}
      <div className="relative mb-2">
        {/* SVG 虚线穿针 — 基于实际DOM坐标，不错位 */}
        {showHint && hintCoords && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none z-10"
            viewBox={`0 0 ${hintSvgW} ${hintSvgH}`}>
            <polyline
              fill="none"
              stroke="rgba(217,119,6,0.3)"
              strokeWidth="0.8"
              strokeDasharray="3,4"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={hintCoords}
            />
          </svg>
        )}
        <div className="grid gap-1" ref={gridRef} style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}>
          {grid.map((row, r) => row.map((w, c) => {
            const idx = selected.findIndex(s => s.r === r && s.c === c);
            const isSel = idx >= 0;
            const isPath = solved && status === 'correct' && path.some(p => p.r === r && p.c === c);
            let bg = 'bg-white', border = 'border-gray-200', text = 'text-gray-700';
            if (isSel) { bg = status === 'wrong' ? 'bg-red-100' : 'bg-indigo-100'; border = status === 'wrong' ? 'border-red-300' : 'border-indigo-400'; text = 'text-indigo-800'; }
            if (isPath) { bg = 'bg-green-100'; border = 'border-green-400'; text = 'text-green-800'; }
            return (
              <button key={`${r}-${c}`} onClick={() => clickCell(r, c)}
                className={'aspect-square rounded border text-[9px] font-medium flex items-center justify-center leading-none px-0.5 ' + bg + ' ' + border + ' ' + text}>
                {w}
              </button>
            );
          }))}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-gray-400">已选 {selected.length}/{target.length}</span>
        <div className="flex gap-2">
          <button onClick={reset} disabled={solved} className="text-[11px] px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40">重置</button>
          {!solved && (
            <button onClick={showAnswer} className="text-[11px] px-2 py-1 rounded border border-amber-300 text-amber-600 bg-amber-50 hover:bg-amber-100">💡 显示答案</button>
          )}
          {!solved && (
            <>
              <button onClick={() => { setHint1(v => !v); setHint2(false); setHint3(false); }} className={'text-[11px] px-2 py-1 rounded border ' + (hint1 ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50')}>
                💡 提示1
              </button>
              <button onClick={() => { setHint2(v => !v); setHint1(false); setHint3(false); }} className={'text-[11px] px-2 py-1 rounded border ' + (hint2 ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50')}>
                💡 提示2
              </button>
              <button onClick={() => { setHint3(v => !v); setHint1(false); setHint2(false); }} className={'text-[11px] px-2 py-1 rounded border ' + (hint3 ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50')}>
                💡 提示3
              </button>
            </>
          )}
          <button onClick={() => evaluate(selected)} disabled={solved || selected.length !== target.length}
            className="text-[11px] px-3 py-1 rounded bg-gray-800 text-white disabled:opacity-40">检查</button>
        </div>
      </div>
      {solved && status === 'correct' && (
        revealed
          ? <div className="mt-2 px-3 py-2 rounded text-xs bg-red-50 text-red-700">💡 已显示答案 · 本题计为错误（未自己完成）<br/>句子：{target.join(' ')}</div>
          : <div className="mt-2 px-3 py-2 rounded text-xs bg-green-50 text-green-700">✓ 找到了！句子：{target.join(' ')}</div>
      )}
      {solved && status === 'wrong' && (
        <div className="mt-2 px-3 py-2 rounded text-xs bg-red-50 text-red-700">✗ 这条路径不是目标句，再试试</div>
      )}
    </div>
  );
}

/* ── 形近辨析：⑨ Look-alike ── */
function LookAlike({ q, initialResult, onCommit, onSolved }) {
  const target = q.word;
  const confusers = q.confusers || [];
  const targetKey = target + '|' + confusers.join(',');

  const { grid, size, total } = useMemo(() => generateLookalikeGrid(target, confusers), [targetKey]); // eslint-disable-line

  const [found, setFound] = useState([]);
  const [wrong, setWrong] = useState([]);
  const [errorCount, setErrorCount] = useState(0);
  const [solved, setSolved] = useState(false);

  useEffect(() => {
    if (initialResult && initialResult.is_correct) {
      const all = [];
      grid.forEach((row, r) => row.forEach((w, c) => { if (w && w.toLowerCase() === target.toLowerCase()) all.push(r * size + c); }));
      setFound(all); setSolved(true);
    } else { setFound([]); setWrong([]); setErrorCount(0); setSolved(false); }
  }, [targetKey]); // eslint-disable-line

  const clickCell = (r, c) => {
    if (solved) return;
    const idx = r * size + c;
    if (found.includes(idx) || wrong.includes(idx)) return;
    const w = grid[r][c];
    if (w && w.toLowerCase() === target.toLowerCase()) {
      const nf = [...found, idx];
      setFound(nf);
      if (nf.length === total) {
        const noErr = errorCount === 0;
        setSolved(true);
        onCommit(noErr, `found ${nf.length}/${total} errors ${errorCount}`, target);
        onSolved(noErr);
      }
    } else {
      setErrorCount(e => e + 1);
      setWrong([...wrong, idx]);
      setTimeout(() => setWrong(w => w.filter(x => x !== idx)), 500);
    }
  };

  return (
    <div>
      <p className="text-[11px] text-indigo-500 mb-1">形近辨析 · 只圈出目标词，避开形近干扰词</p>
      <div className="bg-indigo-50 border border-indigo-100 rounded px-3 py-2 mb-2">
        <p className="text-[10px] text-indigo-400">本轮目标词</p>
        <p className="text-xl font-bold text-indigo-800">{target}</p>
        {q.definition && <p className="text-[10px] text-indigo-400 mt-0.5">{q.definition}</p>}
      </div>
      {q.chinese && <p className="text-xs text-gray-500 mb-2">🔍 提示：{q.chinese}</p>}
      {q.sentence && <p className="text-[10px] text-gray-400 mb-2 italic">"{q.sentence}"</p>}
      <div className="grid gap-1 mb-2" style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}>
        {grid.map((row, r) => row.map((w, c) => {
          const idx = r * size + c;
          const isFound = found.includes(idx);
          const isWrong = wrong.includes(idx);
          let bg = 'bg-white border-gray-200', text = 'text-gray-700';
          if (isFound) { bg = 'bg-green-100 border-green-400'; text = 'text-green-800'; }
          else if (isWrong) { bg = 'bg-red-100 border-red-300'; text = 'text-red-700'; }
          return (
            <button key={idx} onClick={() => clickCell(r, c)}
              className={'aspect-square rounded border text-[10px] font-medium flex items-center justify-center leading-none px-0.5 ' + bg + ' ' + text}>
              {w}
            </button>
          );
        }))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-gray-400">已找到 {found.length}/{total} · 误点 {errorCount}</span>
        {solved && (
          <span className={'text-[11px] px-2 py-0.5 rounded ' + (errorCount === 0 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700')}>
            {errorCount === 0 ? '✓ 完美！' : `✓ 完成（误点 ${errorCount} 次）`}
          </span>
        )}
      </div>
    </div>
  );
}

// 错误边界：防止结果页渲染崩溃导致白屏
class ResultErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Practice 结果页渲染错误:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-8 text-center bg-gray-50">
          <p className="text-red-600 font-bold text-lg">结果页加载出错</p>
          <pre className="text-xs text-red-500 bg-red-50 rounded p-3 max-w-2xl overflow-auto whitespace-pre-wrap text-left">
            {String(this.state.error && this.state.error.stack || this.state.error)}
          </pre>
          <button onClick={() => window.location.reload()}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm">刷新页面</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function Practice() {
  const [searchParams] = useSearchParams();
  const roomCode = searchParams.get('room_code');
  const navigate = useNavigate();

  const [modes, setModes] = useState([]);           // 老师选定的模式列表
  const [questionsByMode, setQuestionsByMode] = useState({}); // { [mode]: [...] }
  const [activeMode, setActiveMode] = useState(null);         // 当前选中的模式
  const [sessionId, setSessionId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showResult, setShowResult] = useState(false);
  const [results, setResults] = useState([]);               // 所有已答记录（跨模式）

  // 通用交互态（非翻卡牌模式用）
  const [selectedWord, setSelectedWord] = useState(null);
  const [isCorrect, setIsCorrect] = useState(null);
  const [showHint, setShowHint] = useState(false);
  const [typed, setTyped] = useState('');
  const [spellChecked, setSpellChecked] = useState(false);
  const [buildOrder, setBuildOrder] = useState(null);
  const [buildChecked, setBuildChecked] = useState(false);
  // 组词成句：三级提示（1=中文翻译 / 2=前半句 / 3=完整句子）
  const [buildHintLevel, setBuildHintLevel] = useState(0);

  // 拖曳语块成句：状态
  const [chunkSlots, setChunkSlots] = useState([]);   // 每个空位放置的语块（null=空）
  const [chunkPool, setChunkPool] = useState([]);     // 待选语块池
  const [chunkBlankIndices, setChunkBlankIndices] = useState([]); // 哪些位置是挖空的
  const [chunkChecked, setChunkChecked] = useState(false);
  const [chunkIsCorrect, setChunkIsCorrect] = useState(null);
  const [chunkHintLevel, setChunkHintLevel] = useState(0); // 三级提示
  const [dragData, setDragData] = useState(null);    // { source:'pool'|'slot', index, chunk }
  const [selectedPoolIdx, setSelectedPoolIdx] = useState(null); // 点击放置：选中的语块池索引

  // 连线题状态
  const [matchLeftSel, setMatchLeftSel] = useState(null);    // 左侧当前选中的词
  const [matchPairs, setMatchPairs] = useState({});           // { leftIdx: rightIdx } 用户连线
  const [matchChecked, setMatchChecked] = useState(false);    // 是否已检查结果

  // 字典
  const [queryWord, setQueryWord] = useState('');
  const [dictResult, setDictResult] = useState(null);
  const [dictLoading, setDictLoading] = useState(false);
  const [dictError, setDictError] = useState('');

  // 底部栏
  const [showNumbers, setShowNumbers] = useState(false);     // 题号区展开/收起
  const [fcDone, setFcDone] = useState(new Set());           // 翻卡牌已完成的对数（每局）

  // 新模式（搭配拼词/词格找句/形近辨析）的已答状态
  const [solved, setSolved] = useState({ answered: false, correct: null });

  // ══ 总用时计时 + 暂停 ══
  const [elapsedSec, setElapsedSec] = useState(0);   // 当前显示用秒数
  const [paused, setPaused] = useState(false);       // 是否处于暂停（护眼幕）
  const [pauseCount, setPauseCount] = useState(0);   // 暂停次数
  const accumRef = useRef(0);          // 已累计秒数（不含当前计时段）
  const segStartRef = useRef(Date.now()); // 当前计时段起点
  const pausedRef = useRef(false);
  const pauseCountRef = useRef(0);
  const finishedRef = useRef(false);
  const STORE_KEY = 'practice_timer_' + (roomCode || '');

  // 计算到目前为止的总秒数（实时）
  const getElapsedSec = () => {
    const seg = pausedRef.current ? 0 : (Date.now() - segStartRef.current) / 1000;
    return accumRef.current + seg;
  };
  // 时钟格式化 mm:ss / h:mm:ss
  const fmtClock = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  };

  // 进入房间即开始计时；退出/卸载自动暂停并持久化累计
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
      if (saved && typeof saved.elapsed === 'number') {
        accumRef.current = saved.elapsed;
        pauseCountRef.current = saved.pauseCount || 0;
        setPauseCount(saved.pauseCount || 0);
        setElapsedSec(Math.floor(saved.elapsed));
      }
    } catch (_) { /* ignore */ }
    segStartRef.current = Date.now();
    const timer = setInterval(() => {
      if (!finishedRef.current && !pausedRef.current) {
        setElapsedSec(Math.floor(getElapsedSec()));
      }
    }, 1000);
    const persist = () => {
      if (finishedRef.current) return;
      const cur = getElapsedSec();
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ elapsed: cur, pauseCount: pauseCountRef.current })); } catch (_) { /* ignore */ }
    };
    window.addEventListener('beforeunload', persist);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', persist);
      persist();
    };
  }, []);

  // 暂停：冻结累计并 +1 次数，弹出护眼幕（阻断操作）
  const pauseTimer = () => {
    if (pausedRef.current) return;
    accumRef.current = getElapsedSec();
    pauseCountRef.current += 1;
    setPauseCount(pauseCountRef.current);
    pausedRef.current = true;
    setPaused(true);
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ elapsed: accumRef.current, pauseCount: pauseCountRef.current })); } catch (_) { /* ignore */ }
  };
  // 继续：从当前时刻重新计时
  const resumeTimer = () => {
    if (!pausedRef.current) return;
    segStartRef.current = Date.now();
    pausedRef.current = false;
    setPaused(false);
  };

  // 词格找句用：从本模式所有句子的单词里取干扰词池（剔除当前句单词）
  const searchDistractors = useMemo(() => {
    if (activeMode !== 'sentence_search') return [];
    const set = new Set();
    (questionsByMode['sentence_search'] || []).forEach(qq => {
      fullSentence(qq).split(/\s+/).map(w => w.replace(/[^A-Za-z']/g, '')).filter(Boolean)
        .forEach(w => set.add(w.toLowerCase()));
    });
    return [...set];
  }, [activeMode, questionsByMode]);

  // 当前模式下的题目列表 & 进度
  const modeQuestions = useMemo(
    () => (activeMode ? (questionsByMode[activeMode] || []) : []),
    [activeMode, questionsByMode]
  );

  // 当前模式内的索引（只算当前模式的题目）
  const [modeIndex, setModeIndex] = useState(0);

  const currentQuestion = modeQuestions[modeIndex];

  // 跨模式统计
  const answeredCount = results.filter(r => r.is_correct !== undefined).length;
  const correctCount = results.filter(r => r.is_correct).length;
  const accuracyRate = answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0;

  /* ── 加载房间 + 按模式拉取全部题目 ── */
  const loadPractice = useCallback(async ({ onlyWrong, fresh } = {}) => {
    try {
      setLoading(true);
      const roomRes = await api.getRoom(roomCode);
      const r = roomRes.data || roomRes;
      let m = (r.practice_modes || []).filter(x => MODES.some(y => y.id === x));
      if (m.length === 0) m = ['sentence_fill'];
      setModes(m);

      // 并行拉取各模式题目
      const lists = await Promise.all(m.map(mode => api.getQuestions(roomCode, mode).catch(() => [])));
      const qbM = {};
      m.forEach((mode, mi) => {
        const arr = lists[mi] || [];
        qbM[mode] = arr.map((q, qi) => ({ ...q, mode, uid: `${mode}_${qi}` }));
      });
      // 仅重练错题
      if (onlyWrong) {
        const wrongUids = new Set(results.filter(rr => !rr.is_correct).map(rr => rr.uid));
        for (const k of Object.keys(qbM)) {
          qbM[k] = qbM[k].filter(q => wrongUids.has(q.uid));
        }
      }

      const hasAny = Object.values(qbM).some(arr => arr.length > 0);
      if (!hasAny) {
        setError(onlyWrong ? '没有错题可重练' : '该房间还没有可练习的题目');
        setLoading(false);
        return;
      }

      setQuestionsByMode(qbM);
      setActiveMode(m[0]);
      setModeIndex(0);

      // 判断是否恢复上次完成状态
      // fresh=true（删除/全部重练）→ 不恢复；否则检查 localStorage 标记；再否则恢复最近已完成 session
      const freshFlag = localStorage.getItem('fresh_practice:' + roomCode) === '1';
      const shouldResume = !fresh && !onlyWrong && !freshFlag;

      if (shouldResume) {
        try {
          const resumeData = await api.getLatestSession(roomCode);
          const ans = resumeData.answers || [];
          if (ans.length > 0) {
            // 按 uid 匹配题目，恢复 results
            const restored = [];
            const qByUid = {};
            Object.values(qbM).forEach(arr => arr.forEach(q => { qByUid[q.uid] = q; }));
            ans.forEach(a => {
              const q = a.uid ? qByUid[a.uid] : null;
              if (q) {
                restored.push({ uid: q.uid, question: q, student_answer: a.student_answer, is_correct: a.is_correct });
              }
            });
            setResults(restored);
            setSessionId(null); // 恢复显示已完成状态；若学生再交互则新建 session
            setShowResult(true); // 直接展示完成结果页
            setError('');
            setLoading(false);
            return;
          }
        } catch (e) { console.error('恢复上次状态失败', e); }
      }

      // 全新开始：清除 fresh 标记 + 重置所有状态
      localStorage.removeItem('fresh_practice:' + roomCode);
      setSessionId(null); // 延迟到第一次 commit 时创建
      setError('');
      setResults([]);
      // 重置计时器状态（新练习重新开始计时）
      accumRef.current = 0;
      segStartRef.current = Date.now();
      pausedRef.current = false;
      pauseCountRef.current = 0;
      finishedRef.current = false;
      setElapsedSec(0);
      setPaused(false);
      setPauseCount(0);
      try { sessionStorage.removeItem(STORE_KEY); } catch (_) {}
    } catch (err) {
      setError(err.message || '加载题目失败');
    } finally {
      setLoading(false);
    }
  }, [roomCode, results]);

  useEffect(() => {
    if (!roomCode) { navigate('/'); return; }
    if (!getToken()) { navigate('/student'); return; }
    loadPractice();
    // eslint-disable-next-line
  }, [roomCode]);

  /* ── 延迟创建 session（首次答题或切模式时） ── */
  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    try {
      const res = await api.startPractice({
        room_code: roomCode,
        mode_type: modes.join(','),
      });
      setSessionId(res.sessionId);
      return res.sessionId;
    } catch (e) { console.error('创建session失败', e); return null; }
  }, [sessionId, roomCode, modes]);

  /* ── 提交结果 ── */
  const commit = useCallback(async (q, isCorrectVal, studentAnswer, correctAnswer) => {
    const sid = await ensureSession();
    if (!sid) return;
    try {
      await api.submitAnswer({
        session_id: sid,
        question: q.sentence,
        student_answer: studentAnswer,
        correct_answer: correctAnswer,
        word: q.word,
        is_correct: isCorrectVal,
        mode: q.mode || activeMode,
        uid: q.uid,
      });
    } catch (err) { console.error('记录答案失败', err); }
    setResults(prev => {
      const without = prev.filter(rr => rr.uid !== q.uid);
      return [...without, { uid: q.uid, question: q, student_answer: studentAnswer, is_correct: isCorrectVal }];
    });
  }, [ensureSession, activeMode]);

  /* ── 切换模式时重置交互态 ── */
  useEffect(() => {
    if (!currentQuestion) return;
    const res = results.find(rr => rr.uid === currentQuestion.uid);
    if (res) {
      setSelectedWord(res.student_answer || null);
      setIsCorrect(res.is_correct);
      setTyped(res.student_answer || '');
      setSpellChecked(true);
      setBuildOrder(typeof res.student_answer === 'string' ? res.student_answer.split(' ') : null);
      setBuildChecked(true);
      setMatchLeftSel(null);
      setMatchPairs(typeof res.student_answer === 'object' ? (res.student_answer || {}) : {});
      setMatchChecked(true);
      setSolved({ answered: true, correct: res.is_correct });
      // 拖曳语块成句：恢复已答状态
      if (currentQuestion?.mode === 'chunk_build') {
        try {
          const data = JSON.parse(res.student_answer);
          const cs = splitIntoChunks(fullSentence(currentQuestion), 6, 8);
          if (Array.isArray(data)) {
            // 旧格式兼容：全挖空
            setChunkSlots(data);
            setChunkPool(cs.filter(c => !data.includes(c)));
            setChunkBlankIndices(cs.map((_, i) => i));
          } else if (data && Array.isArray(data.slots) && Array.isArray(data.blanks)) {
            // 新格式：{ slots, blanks }
            setChunkSlots(data.slots);
            setChunkBlankIndices(data.blanks);
            setChunkPool(cs.filter((_, i) => data.blanks.includes(i)));
          }
          setChunkChecked(true);
          setChunkIsCorrect(res.is_correct);
        } catch { /* 旧数据非 JSON，忽略 */ }
      }
    } else {
      setSelectedWord(null);
      setIsCorrect(null);
      setTyped('');
      setSpellChecked(false);
      setBuildOrder(null);
      setBuildChecked(false);
      setBuildHintLevel(0);
      setMatchLeftSel(null);
      setMatchPairs({});
      setMatchChecked(false);
      setSolved({ answered: false, correct: null });
      // 拖曳语块成句：初始化
      if (currentQuestion?.mode === 'chunk_build') {
        initChunk();
      }
    }
    setShowHint(false);
  }, [currentQuestion?.uid, currentQuestion?.word, results]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 切换模式标签 ── */
  const switchToMode = (m) => {
    setActiveMode(m);
    // 找到该模式下第一道未答的题
    const qs = questionsByMode[m] || [];
    const firstUnanswered = qs.findIndex(q => !results.some(r => r.uid === q.uid));
    setModeIndex(firstUnanswered >= 0 ? firstUnanswered : 0);
    setShowNumbers(false);
  };

  /* ── 组词乱序（语块/意群） ── */
  const shuffledTokens = useMemo(() => {
    if (currentQuestion?.mode !== 'sentence_build' || !currentQuestion) return [];
    return shuffle(chunkSentence(fullSentence(currentQuestion)));
  }, [currentQuestion?.mode, currentQuestion?.word]);

  /* ── 导航 ── */
  const goNext = () => {
    if (modeIndex < modeQuestions.length - 1) {
      setModeIndex(p => p + 1);
    } else {
      // 当前模式做完了，跳下一个模式
      const curIdx = modes.indexOf(activeMode);
      if (curIdx < modes.length - 1) switchToMode(modes[curIdx + 1]);
      else finishPractice();
    }
  };
  const goPrev = () => {
    if (modeIndex > 0) setModeIndex(p => p - 1);
  };

  /* ── 句子填空：先选（可取消），按「确定答案」才提交 ── */
  const selectFill = (word) => {
    if (isCorrect !== null) return; // 已确认后不可改
    setSelectedWord(prev => (prev === word ? null : word)); // 再点同一项取消
  };
  const confirmFill = () => {
    if (selectedWord === null || isCorrect !== null) return;
    const correct = selectedWord === currentQuestion.correct_answer;
    setIsCorrect(correct);
    commit(currentQuestion, correct, selectedWord, currentQuestion.correct_answer);
  };

  /* 同义替换：先选（再点取消），按「确定答案」才提交 */
  const selectSynonym = (word) => {
    if (isCorrect !== null) return; // 已确认后不再更改
    setSelectedWord(prev => (prev === word ? null : word)); // 再点同一项取消选择
  };
  const confirmSynonym = () => {
    if (selectedWord === null || isCorrect !== null) return;
    const correct = selectedWord === currentQuestion.correct_answer;
    setIsCorrect(correct);
    commit(currentQuestion, correct, selectedWord, currentQuestion.correct_answer);
  };
  const checkSpelling = () => {
    if (spellChecked) return;
    const target = currentQuestion.word || currentQuestion.correct_answer || '';
    const correct = isSpellingAcceptable(typed, target);
    setSpellChecked(true);
    setIsCorrect(correct);
    commit(currentQuestion, correct, typed, target);
  };
  const addToken = (tok) => {
    if (buildChecked) return;
    setBuildOrder(prev => [...(prev || []), tok]);
  };
  const checkBuild = () => {
    if (buildChecked || !buildOrder) return;
    const correct = norm(buildOrder.join(' ')) === norm(fullSentence(currentQuestion));
    setBuildChecked(true);
    setIsCorrect(correct);
    commit(currentQuestion, correct, buildOrder.join(' '), fullSentence(currentQuestion));
  };
  const resetBuild = () => { setBuildOrder(null); setBuildChecked(false); setBuildHintLevel(0); setIsCorrect(null); };

  // 组词成句：获取前半句（按空格切分，取前一半单词）
  const getFirstHalfSentence = (q) => {
    const s = fullSentence(q);
    if (!s) return '';
    const words = s.split(/\s+/);
    const mid = Math.ceil(words.length / 2);
    return words.slice(0, mid).join(' ') + ' …';
  };

  /* ── 拖曳语块成句：逻辑 ── */
  // 当前题的正确语块序列（6~8 个，保证≥4个空格）
  const chunkCorrect = useMemo(() => {
    if (currentQuestion?.mode !== 'chunk_build' || !currentQuestion) return [];
    return splitIntoChunks(fullSentence(currentQuestion), 6, 8);
  }, [currentQuestion?.mode, currentQuestion?.word]);

  const initChunk = useCallback(() => {
    const cs = splitIntoChunks(fullSentence(currentQuestion), 6, 8);
    const n = cs.length;
    // 至少挖空 4 个（或 n-1 个），不连续，尽量保留首尾锚点
    const blankCount = Math.max(4, Math.min(n - 1, Math.ceil(n * 0.6)));
    const blanks = new Set();
    // 候选：优先选中间位置（保留首尾作锚点）
    const candidates = [];
    for (let i = 1; i < n - 1; i++) candidates.push(i);
    shuffleInPlace(candidates);
    let last = -2;
    for (const c of candidates) {
      if (c === last + 1) continue; // 不连续
      blanks.add(c);
      last = c;
      if (blanks.size >= blankCount) break;
    }
    // 如果候选不够（短句），允许选首/尾补足
    if (blanks.size < blankCount && n >= blankCount) {
      const extras = [0, n - 1].filter(i => !blanks.has(i));
      shuffleInPlace(extras);
      for (const e of extras) {
        // 检查是否与已选的连续
        if (!blanks.has(e - 1) && !blanks.has(e + 1)) { blanks.add(e); }
        if (blanks.size >= blankCount) break;
      }
    }
    // 最终兜底：放宽连续限制
    if (blanks.size < Math.min(4, n)) {
      for (let i = 0; i < n; i++) { if (!blanks.has(i)) { blanks.add(i); if (blanks.size >= Math.min(4, n)) break; } }
    }
    const blankArr = Array.from(blanks).sort((a, b) => a - b);
    // slots: 挖空位置=null, 其余预填正确语块
    const slots = cs.map((c, i) => blanks.has(i) ? null : c);
    // pool: 只有被挖空的语块
    const pool = shuffle(cs.filter((_, i) => blanks.has(i)));
    setChunkSlots(slots);
    setChunkPool(pool);
    setChunkBlankIndices(blankArr);
    setChunkChecked(false);
    setChunkIsCorrect(null);
    setChunkHintLevel(0);
    setDragData(null);
    setSelectedPoolIdx(null);
  }, [currentQuestion]);

  const placeChunkIntoSlot = useCallback((targetIdx) => {
    if (!dragData || chunkChecked || !chunkBlankIndices.includes(targetIdx)) return;
    if (dragData.source === 'pool') {
      const newSlots = [...chunkSlots];
      const newPool = [...chunkPool];
      const oldChunk = newSlots[targetIdx];
      newSlots[targetIdx] = dragData.chunk;
      const pi = newPool.indexOf(dragData.chunk);
      if (pi >= 0) newPool.splice(pi, 1);
      if (oldChunk) newPool.push(oldChunk);
      setChunkSlots(newSlots); setChunkPool(newPool);
    } else { // slot → slot（交换）
      const newSlots = [...chunkSlots];
      newSlots[targetIdx] = newSlots[dragData.index];
      newSlots[dragData.index] = chunkSlots[targetIdx];
      setChunkSlots(newSlots);
    }
    setDragData(null);
  }, [dragData, chunkSlots, chunkPool, chunkChecked]);

  const returnChunkToPool = useCallback(() => {
    if (!dragData || dragData.source !== 'slot' || chunkChecked) return;
    const newSlots = [...chunkSlots];
    newSlots[dragData.index] = null;
    setChunkSlots(newSlots);
    setChunkPool([...chunkPool, dragData.chunk]);
    setDragData(null);
  }, [dragData, chunkSlots, chunkPool, chunkChecked]);

  // 点击放置（触屏兜底）：先点语块池选中，再点空位放置；点已填空位则退回池
  const clickPoolChunk = (i) => {
    if (chunkChecked) return;
    setSelectedPoolIdx(i);
  };
  const clickSlot = (targetIdx) => {
    if (chunkChecked || !chunkBlankIndices.includes(targetIdx)) return; // 锚点不可点击
    if (selectedPoolIdx !== null) {
      const newSlots = [...chunkSlots];
      const newPool = [...chunkPool];
      const oldChunk = newSlots[targetIdx];
      newSlots[targetIdx] = chunkPool[selectedPoolIdx];
      newPool.splice(selectedPoolIdx, 1);
      if (oldChunk) newPool.push(oldChunk);
      setChunkSlots(newSlots); setChunkPool(newPool);
      setSelectedPoolIdx(null);
    } else if (chunkSlots[targetIdx]) {
      const newSlots = [...chunkSlots];
      const chunk = newSlots[targetIdx];
      newSlots[targetIdx] = null;
      setChunkSlots(newSlots);
      setChunkPool([...chunkPool, chunk]);
    }
  };

  const checkChunk = () => {
    if (chunkChecked || chunkSlots.length === 0) return;
    // 只校验挖空位置是否正确（非挖空位置已预填正确语块）
    const correct = chunkBlankIndices.every(i => chunkSlots[i] === chunkCorrect[i]);
    setChunkChecked(true);
    setChunkIsCorrect(correct);
    commit(currentQuestion, correct, JSON.stringify({ slots: chunkSlots, blanks: chunkBlankIndices }), chunkCorrect.join(' '));
  };
  const resetChunk = () => initChunk();

  /* ── 完成 ── */
  const finishPractice = useCallback(async () => {
    // 补录未作答的题目（确保教师端能看到全部词汇）
    const allQuestions = Object.values(questionsByMode).flat();
    const answeredUids = new Set(results.map(r => r.uid));
    const sid = sessionId || await ensureSession();
    for (const q of allQuestions) {
      if (!answeredUids.has(q.uid)) {
        try {
          await api.submitAnswer({
            session_id: sid,
            question: q.sentence || q.word,
            student_answer: '(未作答)',
            correct_answer: q.correct_answer || fullSentence(q) || '',
            word: q.word || q.correct_answer || '',
            is_correct: false,
            mode: q.mode || 'unknown',
            uid: q.uid,
          });
        } catch { /* 静默失败，不影响主流程 */ }
      }
    }

    const cc = results.filter(r => r.is_correct).length;
    const total = allQuestions.length;
    const score = total > 0 ? Math.round((cc / total) * 100) : 0;
    const elapsed = Math.round(getElapsedSec());
    const pc = pauseCountRef.current;
    finishedRef.current = true; // 停止计时 + 不再持久化
    try { sessionStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ }
    try {
      await api.finishPractice({ session_id: sid, score, total_questions: total, correct_count: cc, elapsed_time: elapsed, pause_count: pc });
    } catch (err) {
      console.error('结束练习失败', err);
    }
    setShowResult(true);
  }, [results, questionsByMode, sessionId, ensureSession]);

  const restartPractice = async (onlyWrong) => {
    setShowResult(false);
    if (!onlyWrong) {
      // 「全部重练」：明确刷新状态
      try { localStorage.setItem('fresh_practice:' + roomCode, '1'); } catch (_) {}
    }
    await loadPractice({ onlyWrong });
  };

  /* ── 字典（走后端代理：英文释义 + 中文翻译）── */
  const callDict = async () => {
    const w = queryWord.trim();
    if (!w) return;
    setDictLoading(true); setDictError(''); setDictResult(null);
    try {
      const res = await api.lookupWord(w);
      if (res.error) throw new Error(res.error);
      setDictResult(res);
    } catch (e) { setDictError(e.message || '查词失败'); }
    finally { setDictLoading(false); }
  };

  // 去除字符串末尾的中文/词性标注（后端已清洗，前端再做一次安全网）
  const stripChinese = (s) => {
    if (typeof s !== 'string') return s;
    return s.replace(/\s*(?:adj\.?|v\.?|n\.?|adv\.?|phrase\.?)\s*[\u4e00-\u9fff\u3400-\u4dbf][\u4e00-\u9fff\s（）()""''「」【】、。！？：；—…·]*$/, '').trim()
           .replace(/^[""\s]+|[""\s]+$/g, '').trim() || s;
  };

  const defChoices = useMemo(() => {
    if (!currentQuestion) return [];
    return (currentQuestion.options || []).map((opt, i) => ({
      word: stripChinese(opt),
      def: stripChinese((currentQuestion.option_defs && currentQuestion.option_defs[i]) || `"${opt}"`),
    }));
  }, [currentQuestion]);

  // 各模式进度摘要
  const modeProgress = useMemo(() => {
    const mp = {};
    for (const m of modes) {
      const qs = questionsByMode[m] || [];
      const done = qs.filter(q => results.some(r => r.uid === q.uid)).length;
      const ok = qs.filter(q => results.some(r => r.uid === q.uid && r.is_correct)).length;
      mp[m] = { done, ok, total: qs.length };
    }
    return mp;
  }, [modes, questionsByMode, results]);

  // ===== Loading / Error =====
  if (loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-600 mx-auto"></div>
        <p className="mt-3 text-xs text-gray-500">加载题目中...</p>
      </div>
    </div>
  );
  if (error) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow p-6 text-center max-w-sm w-full">
        <p className="text-sm text-red-600 mb-3">{error}</p>
        <button onClick={() => navigate('/')} className="text-xs bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-700">返回首页</button>
      </div>
    </div>
  );

  // ===== 完成结果（含逐题详情） =====
  if (showResult) {
    const cc = results.filter(r => r.is_correct).length;
    const totalAll = Object.values(questionsByMode).flat().length;
    const sc = totalAll > 0 ? Math.round((cc / totalAll) * 100) : 0;

    // 按 mode 分组 results
    const resultsByMode = {};
    modes.forEach(m => { resultsByMode[m] = []; });
    results.forEach(r => {
      const m = r.question?.mode || activeMode;
      if (!resultsByMode[m]) resultsByMode[m] = [];
      resultsByMode[m].push(r);
    });

    // 渲染单道题的详情卡片
    const renderQuestionDetail = (r, idx) => {
      const q = r.question;
      const mode = q?.mode || '';
      const isOk = r.is_correct;
      const isSkipped = !r.student_answer || r.student_answer === '' || r.student_answer === '（未作答）';

      return (
        <div key={r.uid || idx} className={'border rounded-lg p-2.5 text-xs ' + (isOk ? 'border-green-200 bg-green-50/50' : 'border-red-200 bg-red-50/50')}>
          {/* 题号 + 状态 */}
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-semibold text-gray-700">#{idx + 1} {modeLabel(mode)}</span>
            <span className={'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ' +
              (isOk ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600')}>
              {isOk ? '✓ 正确' : (isSkipped ? '✗ 未作答' : '✗ 错误')}
            </span>
          </div>

          {/* 题目内容 — 按模式差异化展示 */}
          <div className="space-y-1">
            {/* 目标词 */}
            {q?.word && (
              <p className="text-gray-800 font-medium">📝 <span className="font-bold">{typeof q.word === 'object' ? (q.word?.word || q.word?.[0] || JSON.stringify(q.word)) : String(q.word)}</span></p>
            )}

            {/* 句子填空 / 词格找句：显示原句 */}
            {(mode === 'sentence_fill' || mode === 'sentence_search') && q?.sentence && (
              <p className="text-gray-600 leading-relaxed bg-white rounded px-2 py-1 border border-gray-100">
                {typeof q.sentence === 'object' ? JSON.stringify(q.sentence) : String(q.sentence)}
              </p>
            )}

            {/* 中文翻译 */}
            {q?.chinese && (
              <p className="text-gray-500 italic">💬 {typeof q.chinese === 'object' ? JSON.stringify(q.chinese) : String(q.chinese)}</p>
            )}

            {/* 学生答案 */}
            <div className="flex items-start gap-1 mt-1">
              <span className="text-gray-400 shrink-0">👉 你的答案：</span>
              <span className={(isSkipped ? 'text-gray-300 italic' : isOk ? 'text-green-700 font-medium' : 'text-red-600 line-through')}>
                {isSkipped ? '（未作答）' : (typeof r.student_answer === 'object' ? JSON.stringify(r.student_answer) : (r.student_answer || '—'))}
              </span>
            </div>

            {/* 错误时显示正确答案 */}
            {!isOk && q && (
              <div className="flex items-start gap-1">
                <span className="text-green-500 shrink-0">✅ 正确答案：</span>
                <span className="text-green-700 font-medium">{typeof r.correct_answer === 'object' ? JSON.stringify(r.correct_answer) : (r.correct_answer || typeof q.word === 'string' ? q.word : (q.word?.word || '—'))}</span>
              </div>
            )}

            {/* 连线题特殊展示 */}
            {mode === 'match' && r.student_answer && (() => {
              try {
                const pairs = JSON.parse(r.student_answer);
                if (Array.isArray(pairs)) {
                  return (
                    <div className="mt-1 bg-white rounded px-2 py-1 border border-gray-100 space-y-0.5">
                      {pairs.map((p, i) => (
                        <p key={i} className="text-gray-600">{p.left} → {p.right}</p>
                      ))}
                    </div>
                  );
                }
              } catch { /* ignore */ }
              return null;
            })()}

            {/* 组词成句/拖曳语块特殊展示 */}
            {(mode === 'sentence_build' || mode === 'chunk_build') && r.student_answer && (() => {
              try {
                const arr = JSON.parse(r.student_answer);
                if (Array.isArray(arr)) {
                  return (
                    <div className="mt-1 bg-white rounded px-2 py-1 border border-gray-100">
                      <p className="text-gray-700">{arr.join(' ')}</p>
                    </div>
                  );
                }
              } catch { /* ignore */ }
              return null;
            })()}
          </div>
        </div>
      );
    };

    return (
      <ResultErrorBoundary>
      <div className="min-h-screen bg-gray-50 p-3 pb-24">
        <div className="max-w-lg mx-auto">
          {/* 汇总卡片 */}
          <div className="bg-white rounded-lg shadow-sm p-4 text-center mb-3">
            <p className="text-base font-bold text-gray-800">练习完成</p>
            <p className="text-[11px] text-gray-400 mb-1">{modes.length} 种练习模式</p>
            <p className="text-3xl font-bold" style={{ color: sc >= 60 ? '#16a34a' : '#dc2626' }}>{sc}%</p>
            <p className="text-xs text-gray-500 mt-0.5">答对 {cc} / {totalAll}</p>
          </div>

          {/* 各模式小计 */}
          <div className="bg-white rounded-lg shadow-sm p-3 mb-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {modes.map(m => {
                const p = modeProgress[m] || {};
                return (
                  <div key={m} className="flex items-center justify-between text-[11px]">
                    <span className="text-gray-600">{modeLabel(m)}</span>
                    <span className={p.total ? 'text-gray-800 font-medium' : 'text-gray-300'}>
                      {p.ok || 0}/{p.done || 0}/{p.total || 0}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ===== 逐题详情 ===== */}
          <div className="mb-3">
            <p className="text-xs font-bold text-gray-700 mb-2 flex items-center gap-1">
              📋 逐题详情
              <span className="font-normal text-gray-400">({results.length} 题)</span>
            </p>
            <div className="space-y-2">
              {modes.map(m => {
                const items = resultsByMode[m] || [];
                if (items.length === 0) return null;
                // 该模式下未作答的题目也显示（从 questionsByMode 取）
                const allQs = questionsByMode[m] || [];
                const answeredUids = new Set(items.map(i => i.uid));
                const missingQs = allQs.filter(q => !answeredUids.has(q.uid));

                return (
                  <div key={m}>
                    {/* 模式标题 */}
                    <p className="text-[11px] font-semibold text-indigo-600 mb-1 pl-1 border-l-2 border-indigo-300">
                      {modeLabel(m)} ({items.length + missingQs.length} 题)
                    </p>
                    <div className="space-y-1.5">
                      {items.map((r, i) => renderQuestionDetail(r, i))}
                      {/* 未答题 */}
                      {missingQs.map((q, i) => renderQuestionDetail({
                        uid: q.uid,
                        question: q,
                        student_answer: '',
                        is_correct: false,
                        correct_answer: q.word || q.answer || ''
                      }, items.length + i))}
                    </div>
                  </div>
                );
              })}

              {results.length === 0 && Object.values(questionsByMode).every(arr => arr.length === 0) && (
                <p className="text-xs text-gray-400 text-center py-4">暂无题目数据</p>
              )}
            </div>
          </div>

          {/* 底部按钮 */}
          <div className="flex gap-2 mb-3 sticky bottom-0 bg-gray-50 pb-2 pt-1">
            <button onClick={() => navigate('/history')} className="flex-1 text-xs bg-gray-800 text-white py-2.5 rounded hover:bg-gray-700">查看历史</button>
            <button onClick={() => navigate('/')} className="flex-1 text-xs border border-gray-300 text-gray-700 py-2.5 rounded hover:bg-gray-50">返回首页</button>
          </div>
          <div className="grid grid-cols-2 gap-2 pb-1">
            <button onClick={() => restartPractice(false)} className="text-xs bg-indigo-600 text-white py-2.5 rounded-lg hover:bg-indigo-700">🔄 换一批新题</button>
            {results.some(r => !r.is_correct) && (
              <button onClick={() => restartPractice(true)} className="text-xs bg-amber-500 text-white py-2.5 rounded-lg hover:bg-amber-600">⚠️ 重练错题 ({results.filter(r => !r.is_correct).length})</button>
            )}
          </div>
          <p className="text-[11px] text-gray-400 text-center pb-4">内置题库每次都会从词库随机抽取不同题目；点「换一批新题」可立即重新出题</p>
        </div>
      </div>
      </ResultErrorBoundary>
    );
  }

  // ===== 主界面 =====
  const q = currentQuestion;
  const answered = isCorrect !== null;
  // 新模式（搭配/找句/形近）用 solved 状态驱动「下一题」按钮
  const isNewMode = ['collocation', 'sentence_search', 'lookalike', 'match'].includes(activeMode);
  const answeredNow = isNewMode ? solved.answered : answered;

  return (
    <div className="min-h-screen bg-gray-50 p-3 pb-36">
      <div className="max-w-lg mx-auto">

        {/* ═══ 总用时计时条 ═══ */}
        <div className="sticky top-0 z-30 bg-gray-50 pt-1 pb-1 mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500">总用时</span>
            <span className="font-mono text-base font-bold text-indigo-700 tabular-nums">{fmtClock(elapsedSec)}</span>
            {pauseCount > 0 && <span className="text-[10px] text-gray-400">暂停 {pauseCount} 次</span>}
          </div>
          <button onClick={pauseTimer}
            className="text-[11px] px-3 py-1.5 rounded-full border border-gray-300 text-gray-600 bg-white hover:bg-gray-100 active:scale-95 transition">
            ⏸ 暂停
          </button>
        </div>

        {/* ═══ 可点击的模式标签条 ═══ */}
        <div className="flex gap-1.5 overflow-x-auto pb-2 mb-1 sticky top-11 bg-gray-50 z-10 pt-1">
          {modes.map(m => {
            const prog = modeProgress[m] || {};
            const isActive = m === activeMode;
            const isDone = prog.done >= prog.total && prog.total > 0;
            return (
              <button key={m} onClick={() => switchToMode(m)}
                className={'shrink-0 text-[11px] px-2.5 py-1.5 rounded-full border whitespace-nowrap transition '
                  + (isActive
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : isDone
                      ? 'bg-green-50 text-green-700 border-green-200'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300')}
              >
                {modeLabel(m)}
                {prog.total > 0 && <span className={'ml-1 opacity-60'}>{prog.done}/{prog.total}</span>}
              </button>
            );
          })}
        </div>

        {/* ═══ 翻卡牌模式：独立渲染配对游戏 ═══ */}
        {activeMode === 'flashcard' && (
          <div className="space-y-3">
            <div className="bg-white rounded-lg shadow-sm px-4 pb-4">
              <MemoryMatch
                words={modeQuestions}
                onDone={({ totalPairs, moves }) => {
                  setFcDone(prev => new Set(prev).add(activeMode));
                  // 记录翻卡牌结果（按词记为正确）
                  modeQuestions.forEach(wq => {
                    if (!results.find(r => r.uid === wq.uid)) {
                      commit(wq, true, 'memory_match', wq.word);
                    }
                  });
                }}
              />
            </div>
            {/* 翻卡牌完成后显示「进入下一模式」按钮 */}
            {fcDone.has(activeMode) && (
              <div className="flex gap-2">
                {modes.indexOf(activeMode) < modes.length - 1 ? (
                  <button onClick={() => switchToMode(modes[modes.indexOf(activeMode) + 1])}
                    className="flex-1 text-xs bg-indigo-600 text-white py-2.5 rounded-lg hover:bg-indigo-700 font-medium">
                    进入下一模式 → {modeLabel(modes[modes.indexOf(activeMode) + 1])}
                  </button>
                ) : (
                  <button onClick={finishPractice} className="flex-1 text-xs bg-green-600 text-white py-2.5 rounded-lg hover:bg-green-700 font-medium">完成全部练习 ✓</button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ 其他模式：逐题渲染 ═══ */}
        {activeMode !== 'flashcard' && q && (
          <>
            {/* 模式标题 */}
            <div className="mb-1 rounded-lg bg-indigo-600 text-white px-3 py-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold">{modeLabel(activeMode)}</span>
              <span className="text-[10px] opacity-80 hidden sm:inline">{modeDesc(activeMode)}</span>
            </div>

            {/* 标签栏 */}
            <div className="bg-white rounded-t-lg shadow-sm px-3 pt-3 pb-2 flex flex-wrap gap-1.5">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium">{modeLabel(activeMode)}</span>
              {q.topic_category && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">{q.topic_category}</span>}
              {q.thinking_tag && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-medium">{q.thinking_tag}</span>}
            </div>

            {/* 题目卡片 */}
            <div className="bg-white shadow-sm px-4 pb-4">

              {/* —— 句子填空 —— */}
              {activeMode === 'sentence_fill' && (
                <>
                  {q.chinese && <p className="text-xs text-gray-400 mb-2 leading-relaxed">{q.chinese}</p>}
                  <p className="text-base leading-relaxed mb-4 text-gray-800">
                    {(q.sentence || '').split(/_{4,}/).map((part, idx, arr) => (
                      <span key={idx}>{part}{idx < arr.length - 1 && <span className="inline-block min-w-[80px] mx-0.5 border-b-2 border-indigo-300"></span>}</span>
                    ))}
                  </p>
                  {!answered && (q.definition || (q.option_defs && q.option_defs.length)) && (
                    <button onClick={() => setShowHint(!showHint)} className="text-[11px] text-indigo-500 mb-3 hover:text-indigo-700">{showHint ? '隐藏释义' : '💡 显示所有词汇释义'}</button>
                  )}
                  {showHint && !answered && (
                    <div className="bg-yellow-50 border border-yellow-200 rounded px-3 py-2 mb-3 text-[10px] text-yellow-700">
                      本题所有词汇释义：
                      <div className="space-y-0.5 mt-1">
                        {q.options.map((opt, i) => {
                          const isC = opt === q.correct_answer;
                          const def = (q.option_defs && q.option_defs[i]) || (isC ? q.definition : '');
                          return <div key={i} className="text-xs flex gap-1 text-yellow-800">
                            <span>{String.fromCharCode(65 + i)}. {opt}</span>{def && <span className="opacity-80">— {def}</span>}{!def && <span className="opacity-50 italic">— (暂无)</span>}
                          </div>;
                        })}
                      </div>
                    </div>
                  )}
                  <OptionGrid q={q} selectedWord={selectedWord} isCorrect={isCorrect} onSelect={selectFill} />
                  {isCorrect === null && selectedWord !== null && (
                    <button onClick={confirmFill}
                      className="mt-3 w-full text-sm bg-indigo-600 text-white py-2.5 rounded-lg hover:bg-indigo-700 font-medium">
                      确定答案
                    </button>
                  )}
                  {isCorrect === null && selectedWord === null && (
                    <p className="mt-3 text-center text-xs text-gray-400">请选择一个词</p>
                  )}
                </>
              )}

              {/* —— 同义替换 —— */}
              {activeMode === 'synonym' && (
                <>
                  <p className="text-[11px] text-indigo-500 mb-1">同义替换 · 选出正确的释义</p>
                  <p className="text-2xl font-bold text-gray-800 mb-4">{stripChinese(q.word)}</p>
                  <div className="grid grid-cols-1 gap-2">
                    {defChoices.map((c, i) => {
                      let cls = 'border rounded-lg text-left transition text-sm px-3 py-2.5 ';
                      const isRight = c.word === q.correct_answer;
                      const isSelected = selectedWord === c.word;
                      const isAnswered = isCorrect !== null;
                      if (!isAnswered) {
                        // 选择阶段：选中高亮，未选中性
                        if (isSelected) cls += 'border-indigo-400 bg-indigo-50 text-indigo-800 font-medium';
                        else cls += 'border-gray-200 hover:border-indigo-300 active:bg-indigo-50';
                      } else {
                        // 已确认：正确绿、选错红、其余灰
                        if (isRight) cls += 'border-green-400 bg-green-50 text-green-800';
                        else if (isSelected) cls += 'border-red-400 bg-red-50 text-red-800';
                        else cls += 'border-gray-100 bg-gray-50 text-gray-400';
                      }
                      return (
                        <button key={i}
                          onClick={() => selectSynonym(c.word)}
                          disabled={isAnswered}
                          className={cls}>
                          {String.fromCharCode(65 + i)}. {c.def}
                        </button>
                      );
                    })}
                  </div>

                  {/* 确定答案 / 提示 */}
                  {isCorrect === null && selectedWord !== null && (
                    <button onClick={confirmSynonym}
                      className="mt-3 w-full text-sm bg-indigo-600 text-white py-2.5 rounded-lg hover:bg-indigo-700 font-medium">
                      确定答案
                    </button>
                  )}
                  {isCorrect === null && selectedWord === null && (
                    <p className="mt-3 text-center text-xs text-gray-400">请选择一个释义</p>
                  )}
                </>
              )}

              {/* —— 连线（左词右义，测量坐标画线） —— */}
              {activeMode === 'match' && (
                <MatchMode
                  q={q}
                  initialResult={results.find(r => r.uid === q.uid)}
                  onCommit={(c, p) => commit(currentQuestion, c, p, q.options.map((o, i) => i))}
                  onSolved={(c) => setSolved({ answered: true, correct: c })}
                />
              )}

              {/* —— 搭配拼词 —— */}
              {activeMode === 'collocation' && (
                <CollocationBuilder
                  q={q}
                  initialResult={results.find(r => r.uid === q.uid)}
                  onCommit={(c, p, ca) => commit(currentQuestion, c, p, ca)}
                  onSolved={(c) => setSolved({ answered: true, correct: c })}
                />
              )}

              {/* —— 词格找句 —— */}
              {activeMode === 'sentence_search' && (
                <SentenceSearch
                  q={q}
                  initialResult={results.find(r => r.uid === q.uid)}
                  onCommit={(c, p, ca) => commit(currentQuestion, c, p, ca)}
                  onSolved={(c) => setSolved({ answered: true, correct: c })}
                  distractorPool={searchDistractors}
                />
              )}

              {/* —— 形近辨析 —— */}
              {activeMode === 'lookalike' && (
                <LookAlike
                  q={q}
                  initialResult={results.find(r => r.uid === q.uid)}
                  onCommit={(c, p, ca) => commit(currentQuestion, c, p, ca)}
                  onSolved={(c) => setSolved({ answered: true, correct: c })}
                />
              )}

              {/* —— 组词成句 —— */}
              {activeMode === 'sentence_build' && (
                <>
                  <p className="text-[11px] text-indigo-500 mb-2">组词成句 · 点击拼出原句</p>

                  {/* 三级提示按钮 */}
                  {!buildChecked && (
                    <div className="flex gap-1.5 mb-2">
                      {buildHintLevel < 1 && (
                        <button onClick={() => setBuildHintLevel(1)}
                          className="text-[11px] px-2.5 py-1 rounded-full border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-indigo-300">
                          💡 提示 1
                        </button>
                      )}
                      {buildHintLevel >= 1 && buildHintLevel < 2 && (
                        <button onClick={() => setBuildHintLevel(2)}
                          className="text-[11px] px-2.5 py-1 rounded-full border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-indigo-300">
                          💡 提示 2
                        </button>
                      )}
                      {buildHintLevel >= 2 && buildHintLevel < 3 && (
                        <button onClick={() => setBuildHintLevel(3)}
                          className="text-[11px] px-2.5 py-1 rounded-full border border-gray-200 text-gray-600 hover:bg-red-50 hover:border-red-300">
                          💡 提示 3
                        </button>
                      )}
                    </div>
                  )}

                  {/* 提示内容展示 */}
                  {buildHintLevel >= 1 && !buildChecked && (
                    <div className="mb-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100 space-y-1">
                      {buildHintLevel >= 1 && (q.chinese || q.zh) && (
                        <p className="text-xs text-blue-800">{q.chinese || q.zh}</p>
                      )}
                      {buildHintLevel >= 2 && (
                        <p className="text-xs text-blue-700 font-mono bg-white rounded px-2 py-1 mt-1">{getFirstHalfSentence(q)}</p>
                      )}
                      {buildHintLevel >= 3 && (
                        <p className="text-xs text-red-700 font-mono bg-red-50 rounded px-2 py-1 mt-1">完整答案：{fullSentence(q)}</p>
                      )}
                    </div>
                  )}

                  <div className="min-h-[44px] border rounded-lg p-2 mb-2 flex flex-wrap gap-1 items-center bg-gray-50">
                    {buildOrder?.length > 0 ? buildOrder.map((w, i) => (
                      <span key={i} className="px-2 py-1 bg-indigo-100 text-indigo-700 rounded text-xs">{w}</span>
                    )) : <span className="text-xs text-gray-400">点击下方单词…</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {shuffledTokens.map((tok, i) => {
                      const used = buildOrder && buildOrder.includes(tok) && buildOrder.filter(x => x === tok).length >= shuffledTokens.filter(x => x === tok).length;
                      return <button key={i} onClick={() => addToken(tok)} disabled={buildChecked || used}
                        className={'px-2.5 py-1.5 rounded text-xs border ' + (used ? 'bg-gray-100 text-gray-300 border-gray-100' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300')}>{tok}</button>;
                    })}
                  </div>
                  {!buildChecked && buildOrder?.length > 0 && (
                    <div className="flex gap-2 mt-3">
                      <button onClick={checkBuild} className="flex-1 py-2 text-xs bg-gray-800 text-white rounded hover:bg-gray-700">检查</button>
                      <button onClick={resetBuild} className="px-3 py-2 text-xs border border-gray-300 rounded text-gray-600 hover:bg-gray-50">重置</button>
                    </div>
                  )}
                  {buildChecked && (
                    <div className={'mt-3 px-3 py-2 rounded text-xs ' + (isCorrect ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700')}>
                      {isCorrect ? '✓ 正确！' : '✗ 不正确。'} 原句：{fullSentence(q)}
                    </div>
                  )}
                </>
              )}

              {/* —— 拼写听写 —— */}
              {activeMode === 'spelling' && (
                <>
                  <p className="text-[11px] text-indigo-500 mb-1">拼写听写 · 看释义写单词</p>
                  <div className="flex items-start gap-2 mb-1">
                    <p className="text-sm text-gray-700 leading-relaxed flex-1">{correctDef(q) || '—'}</p>
                    <button onClick={() => speakWord(q.word || q.correct_answer || '')}
                      className="shrink-0 px-2.5 py-1 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-600 text-[11px] hover:bg-indigo-100 transition flex items-center gap-1"
                      title="发音提示（请先思考语义对应拼写，实在想不到再点提示）">
                      🔊 发音
                    </button>
                  </div>
                  {q.chinese && <p className="text-xs text-gray-400 mb-2">{q.chinese}</p>}
                  {/* 首字母提示 */}
                  <div className="mb-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-100">
                    <span className="text-[10px] text-gray-400 mr-1.5">首字母提示</span>
                    <span className="font-mono text-xs text-gray-600 tracking-wider">{firstLetterHint(q.word || q.correct_answer || '')}</span>
                    <span className="text-[10px] text-gray-300 ml-1.5">（{((q.word || q.correct_answer || '').match(/\s/g) || []).length + 1} 词 / {(q.word || q.correct_answer || '').length} 字母）</span>
                  </div>
                  <input value={typed} onChange={e => setTyped(e.target.value)} disabled={spellChecked}
                    placeholder="输入英文单词…" onKeyDown={e => e.key === 'Enter' && checkSpelling()}
                    className="w-full text-base px-3 py-2.5 border border-gray-200 rounded-lg focus:ring-1 focus:ring-indigo-300 outline-none disabled:bg-gray-50 font-mono tracking-wide" />
                  {!spellChecked && (
                    <button onClick={checkSpelling} className="mt-2 w-full py-2 text-xs bg-gray-800 text-white rounded hover:bg-gray-700">检查拼写</button>
                  )}
                  {spellChecked && (() => {
                    const target = q.word || q.correct_answer || '';
                    const dist = typed ? levenshtein(typed.trim(), target) : 999;
                    return (
                      <div className={'mt-3 px-3 py-2 rounded text-xs ' + (isCorrect ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700')}>
                        {isCorrect
                          ? (dist === 0 ? '✓ 完全正确！' : `✓ 基本正确！（偏差 ${dist} 个字母，在容错范围内）`)
                          : `✗ 不正确。正确答案：${target}`
                        }
                      </div>
                    );
                  })()}
                </>
              )}

              {/* —— 拖曳语块成句 —— */}
              {activeMode === 'chunk_build' && (
                <>
                  <p className="text-[11px] text-indigo-500 mb-2">拖曳语块成句 · 把语块拖入句子的空格</p>

                  {/* 三级提示按钮 */}
                  {!chunkChecked && (
                    <div className="flex gap-1.5 mb-2">
                      {chunkHintLevel < 1 && (
                        <button onClick={() => setChunkHintLevel(1)}
                          className="text-[11px] px-2.5 py-1 rounded-full border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-indigo-300">💡 提示 1</button>
                      )}
                      {chunkHintLevel >= 1 && chunkHintLevel < 2 && (
                        <button onClick={() => setChunkHintLevel(2)}
                          className="text-[11px] px-2.5 py-1 rounded-full border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-indigo-300">💡 提示 2</button>
                      )}
                      {chunkHintLevel >= 2 && chunkHintLevel < 3 && (
                        <button onClick={() => setChunkHintLevel(3)}
                          className="text-[11px] px-2.5 py-1 rounded-full border border-gray-200 text-gray-600 hover:bg-red-50 hover:border-red-300">💡 提示 3</button>
                      )}
                    </div>
                  )}

                  {/* 提示内容展示 */}
                  {chunkHintLevel >= 1 && !chunkChecked && (
                    <div className="mb-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100 space-y-1">
                      {chunkHintLevel >= 1 && (q.chinese || q.zh) && (
                        <p className="text-xs text-blue-800">{q.chinese || q.zh}</p>
                      )}
                      {chunkHintLevel >= 2 && (
                        <p className="text-xs text-blue-700 font-mono bg-white rounded px-2 py-1 mt-1">{getFirstHalfSentence(q)}</p>
                      )}
                      {chunkHintLevel >= 3 && (
                        <p className="text-xs text-red-700 font-mono bg-red-50 rounded px-2 py-1 mt-1">完整答案：{fullSentence(q)}</p>
                      )}
                    </div>
                  )}

                  {/* 句子框架：锚点语块（固定）+ 挖空槽位（可拖填） */}
                  <div
                    onDrop={returnChunkToPool}
                    onDragOver={e => e.preventDefault()}
                    className="min-h-[64px] border rounded-lg p-3 flex flex-wrap gap-2 items-center bg-gray-50"
                  >
                    {chunkSlots.map((chunk, idx) => {
                      const isBlank = chunkBlankIndices.includes(idx);
                      const isOk = chunkChecked && chunk === chunkCorrect[idx];
                      const isBad = chunkChecked && isBlank && chunk !== chunkCorrect[idx];

                      // ── 锚点：非挖空位置，固定显示正确语块 ──
                      if (!isBlank) {
                        return (
                          <span key={idx} className="px-2.5 py-1.5 rounded text-xs font-medium text-gray-700 bg-white border border-gray-200 select-none">
                            {chunk}
                          </span>
                        );
                      }

                      // ── 挖空槽位 ──
                      return (
                        <div
                          key={idx}
                          onDrop={e => { e.stopPropagation(); placeChunkIntoSlot(idx); }}
                          onDragOver={e => e.preventDefault()}
                          onClick={() => clickSlot(idx)}
                          className={'min-w-[58px] px-2 py-1.5 rounded text-xs border-2 border-dashed ' +
                            (chunk
                              ? (isOk ? 'bg-green-100 border-solid border-green-400 text-green-800'
                                 : isBad ? 'bg-red-100 border-solid border-red-400 text-red-700'
                                 : 'bg-indigo-100 border-solid border-indigo-300 text-indigo-700')
                              : 'border-gray-300 text-gray-400 flex items-center justify-center') +
                            ' cursor-pointer'}
                        >
                          {chunk ? (
                            <span
                              draggable={!chunkChecked}
                              onDragStart={e => { e.stopPropagation(); setDragData({ source: 'slot', index: idx, chunk }); }}
                              onDragEnd={() => setDragData(null)}
                            >{chunk}</span>
                          ) : '____'}
                        </div>
                      );
                    })}
                    {chunkSlots.length === 0 && <span className="text-xs text-gray-400">加载中…</span>}
                  </div>

                  {/* 语块池 */}
                  <p className="text-[10px] text-gray-400 mt-2 mb-1">拖动词块到上方空格（也可：先点语块，再点空格）：</p>
                  <div className="flex flex-wrap gap-2">
                    {chunkPool.map((chunk, i) => (
                      <div
                        key={i}
                        draggable={!chunkChecked}
                        onDragStart={e => { e.stopPropagation(); setDragData({ source: 'pool', index: i, chunk }); }}
                        onDragEnd={() => setDragData(null)}
                        onClick={() => clickPoolChunk(i)}
                        className={'px-2.5 py-1.5 rounded text-xs border bg-white cursor-grab active:cursor-grabbing select-none ' +
                          (selectedPoolIdx === i ? 'border-indigo-500 ring-2 ring-indigo-200 text-indigo-700'
                             : 'border-gray-200 text-gray-700 hover:border-indigo-300') +
                          (chunkChecked ? ' opacity-50' : '')}
                      >{chunk}</div>
                    ))}
                    {chunkPool.length === 0 && <span className="text-xs text-gray-400">全部已放入</span>}
                  </div>

                  {/* 检查 / 重置 */}
                  {!chunkChecked && chunkSlots.some(c => c) && (
                    <div className="flex gap-2 mt-3">
                      <button onClick={checkChunk} className="flex-1 py-2 text-xs bg-gray-800 text-white rounded hover:bg-gray-700">检查</button>
                      <button onClick={resetChunk} className="px-3 py-2 text-xs border border-gray-300 rounded text-gray-600 hover:bg-gray-50">重置</button>
                    </div>
                  )}

                  {/* 检查后反馈 */}
                  {chunkChecked && (
                    <div className={'mt-3 px-3 py-2 rounded text-xs ' + (chunkIsCorrect ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700')}>
                      {chunkIsCorrect ? '✓ 全部正确！' : '✗ 有语块顺序不对。'} 原句：{fullSentence(q)}
                    </div>
                  )}
                </>
              )}

              {/* 反馈（填空 / 同义） */}
              {answered && (activeMode === 'sentence_fill' || activeMode === 'synonym') && (
                <div className={'mt-3 px-3 py-2 rounded text-xs ' + (isCorrect ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700')}>
                  {isCorrect ? '✓ 正确！' : `✗ 错误。答案：${q.correct_answer}`}
                </div>
              )}

              {/* 自由查词 */}
              <div className="mt-3 pt-2 border-t border-gray-100">
                <div className="flex gap-1.5">
                  <input value={queryWord} onChange={e => setQueryWord(e.target.value)} onKeyDown={e => e.key === 'Enter' && callDict()}
                    placeholder="复制例句中的词，粘贴查释义"
                    className="flex-1 text-[11px] px-2 py-1.5 border border-gray-200 rounded focus:ring-1 focus:ring-indigo-300 outline-none" />
                  <button onClick={callDict} disabled={dictLoading} className="px-3 text-[11px] bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">{dictLoading ? '...' : '查'}</button>
                </div>
                {dictResult && (
                  <div className="mt-1.5 text-[11px] text-gray-700 bg-gray-50 rounded px-2 py-1.5 space-y-1">
                    <div><b>{dictResult.word}</b>{dictResult.phonetic && <span className="text-gray-400 ml-1">{dictResult.phonetic}</span>}</div>
                    {dictResult.definition && <p className="text-gray-600 leading-snug">{dictResult.definition}</p>}
                    {/* 中文释义 — 最多 2 个，不同颜色 */}
                    {dictResult.chinese && dictResult.chinese.length > 0 && (
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                        {dictResult.chinese.map((c, i) => (
                          <span key={i} className={i === 0 ? 'text-indigo-600 font-medium' : 'text-teal-600 font-medium'}>
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {dictError && <p className="mt-1 text-[10px] text-red-500">{dictError}</p>}
                {dictResult && (<a href={`https://www.dictionary.com/browse/${encodeURIComponent(dictResult.word)}`} target="_blank" rel="noreferrer" className="text-[10px] text-gray-400 hover:text-indigo-500">在词典网站打开 ↗</a>)}
              </div>
            </div>
          </>
        )}

        {/* 非翻卡牌模式的翻题按钮（固定在底部栏上方） */}
        {activeMode !== 'flashcard' && q && (
          <div className="flex gap-2 mt-2">
            <button onClick={goPrev} disabled={modeIndex === 0}
              className="flex-1 py-1.5 text-xs border border-gray-300 rounded text-gray-600 disabled:opacity-30 hover:bg-gray-50">← 上一题</button>
            {answeredNow ? (
              <button onClick={goNext}
                className="flex-1 py-1.5 text-xs bg-gray-800 text-white rounded hover:bg-gray-700">
                {modeIndex < modeQuestions.length - 1 ? '下一题 →' :
                 modes.indexOf(activeMode) < modes.length - 1 ? `${modeLabel(modes[modes.indexOf(activeMode)+1])} →` : '完成'}
              </button>
            ) : (
              <button disabled className="flex-1 py-1.5 text-xs bg-gray-200 text-gray-400 rounded cursor-default">请完成本题</button>
            )}
          </div>
        )}
      </div>

      {/* ═══ 底部固定栏（可收起的题号区） ═══ */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-40 shadow-lg">
        <div className="max-w-lg mx-auto px-3 pt-1.5">
          {/* 收起态：紧凑进度条 + 展开/收起 */}
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] text-gray-500 shrink-0">正确率 {accuracyRate}%</span>
              <span className="text-[10px] text-gray-400 shrink-0">{answeredCount}/{
                Object.values(questionsByMode).flat().filter(q => q.mode !== 'flashcard').length
              }</span>
            </div>
            <button onClick={() => setShowNumbers(v => !v)}
              className="text-[10px] text-indigo-500 shrink-0 px-2 py-0.5 rounded hover:bg-indigo-50 transition">
              {showNumbers ? '▲ 收起' : '▼ 展开题号'}
            </button>
          </div>

          {/* 进度条 */}
          <div className="w-full bg-gray-100 rounded-full h-1 mb-1">
            <div className="h-1 rounded-full transition-all"
              style={{
                width: `${Math.max(...modes.map(m => ((modeProgress[m]?.done||0)/(modeProgress[m]?.total||1)||0))) * 100}%`,
                backgroundColor: accuracyRate >= 70 ? '#16a34a' : accuracyRate >= 40 ? '#eab308' : '#dc2626'
              }}
            />
          </div>

          {/* 提交并退出按钮 */}
          <div className="flex justify-center pb-1.5">
            <button onClick={() => {
              if (!window.confirm('确定要提交并退出吗？\n已完成的题目将保留记录。')) return;
              finishPractice();
              navigate('/');
            }}
              className="text-[10px] text-gray-400 border border-gray-200 rounded px-3 py-1 hover:bg-gray-50 hover:text-gray-600 transition">
              提交并退出
            </button>
          </div>

          {/* 展开态：题号圆圈（可滚动） */}
          {showNumbers && (
            <div className="max-h-28 overflow-y-auto pb-1.5">
              <div className="flex gap-1 flex-wrap justify-center">
                {/* 只展示非翻卡牌模式的题目编号（翻卡牌是整局制） */}
                {Object.entries(questionsByMode).flatMap(([m, qs]) =>
                  m === 'flashcard' ? [] : qs.map((qq, li) => ({ qq, m, li }))
                ).map(({ qq, m }, gi) => {
                  const res = results.find(r => r.uid === qq.uid);
                  const bg = res ? (res.is_correct ? '#16a34a' : '#dc2626') : '#e5e7eb';
                  const isCur = m === activeMode && modeQuestions[modeIndex] && modeQuestions[modeIndex].uid === qq.uid;
                  return (
                    <div key={gi} className="shrink-0 cursor-pointer" onClick={() => { if (m !== activeMode) switchToMode(m); else setModeIndex(gi); }}>
                      <span className={'inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-medium ' + (isCur ? 'ring-2 ring-indigo-400' : '')}
                        style={{ backgroundColor: bg, color: '#fff' }}>{gi + 1}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 翻题按钮（底部栏内，仅非翻卡牌模式） */}
          {activeMode !== 'flashcard' && q && (
            <div className="flex gap-2 pb-1.5">
              <button onClick={goPrev} disabled={modeIndex === 0}
                className="flex-1 py-1.5 text-xs border border-gray-300 rounded text-gray-600 disabled:opacity-30 hover:bg-gray-50">← 上一题</button>
              {answeredNow ? (
                <button onClick={goNext}
                  className="flex-1 py-1.5 text-xs bg-gray-800 text-white rounded hover:bg-gray-700">
                  {modeIndex < modeQuestions.length - 1 ? '下一题 →' :
                   modes.indexOf(activeMode) < modes.length - 1 ? `${modeLabel(modes[modes.indexOf(activeMode)+1])} →` : '完成'}
                </button>
              ) : (
                <button disabled className="flex-1 py-1.5 text-xs bg-gray-200 text-gray-400 rounded cursor-default">请完成本题</button>
              )}
            </div>
          )}
        </div>

        {/* ═══ 暂停护眼幕（约70%透明度，阻断操作）═══ */}
        {paused && (
          <div
            className="fixed inset-0 z-50 flex flex-col items-center justify-center"
            style={{ backgroundColor: 'rgba(168, 213, 186, 0.7)' }}
          >
            <div className="text-center select-none px-6">
              <p className="text-3xl font-bold text-gray-800 mb-2">已暂停</p>
              <p className="text-base text-gray-700 mb-1">总用时 {fmtClock(elapsedSec)}</p>
              <p className="text-sm text-gray-600 mb-6">已暂停 {pauseCount} 次</p>
              <button onClick={resumeTimer}
                className="px-7 py-3 bg-white/90 text-gray-800 rounded-full font-medium shadow-md hover:bg-white active:scale-95 transition">
                ▶ 继续练习
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
