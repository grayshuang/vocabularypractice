// 练习模式定义（教师端分配、学生端练习、教师端统计共用）
// usesBuiltinBank: true 表示该模式使用系统内置题库，不使用老师上传的词汇表
export const MODES = [
  { id: 'sentence_fill', label: '① 句子填空', short: '填空', desc: '句子挖空，从 4 个词中选正确的填进去' },
  { id: 'flashcard', label: '② 翻卡牌', short: '卡牌', desc: '看单词翻面看释义与例句，自评是否记住' },
  { id: 'match', label: '③ 连线题', short: '连线', desc: '把单词和对应的释义连起来' },
  { id: 'synonym', label: '④ 同义替换', short: '同义', desc: '看单词，选出正确的释义' },
  { id: 'sentence_build', label: '⑤ 组词成句', short: '组句', desc: '把打乱的单词按顺序拼成原句' },
  { id: 'spelling', label: '⑥ 拼写听写', short: '拼写', desc: '看释义，拼写出正确的单词' },
  { id: 'collocation', label: '⑦ 搭配拼词', short: '搭配', desc: '选出能和目标词组成地道搭配的词（雅思口语高分搭配）', usesBuiltinBank: true, bankNote: '本练习形式使用系统内置的雅思高分搭配库，不涉及所给词汇表' },
  { id: 'sentence_search', label: '⑧ 词格找句', short: '找句', desc: '在单词网格中划出隐藏的完整句子' },
  { id: 'lookalike', label: '⑨ 形近辨析', short: '形近', desc: '在网格中只圈出目标词，避开形近干扰词', usesBuiltinBank: true, bankNote: '本练习形式使用系统内置的形近陷阱词库，不涉及所给词汇表' },
  { id: 'chunk_build', label: '⑩ 拖曳语块成句', short: '拖句', desc: '句子挖成 4-5 个语块空格，拖动语块填入正确空位拼成原句' },
];

export function modeLabel(id) {
  const m = MODES.find(x => x.id === id);
  return m ? m.label : (id || '未知模式');
}

export function modeShort(id) {
  const m = MODES.find(x => x.id === id);
  return m ? m.short : (id || '?');
}

export function modeDesc(id) {
  const m = MODES.find(x => x.id === id);
  return m ? m.desc : '';
}
