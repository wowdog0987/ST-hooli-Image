import { describe, expect, it } from 'vitest';

import { readHoraeAppearance, readHoraeMemory } from '@/autoTag/horaeMemory';
import type { STMessage } from '@/st/context';

function msg(horae_meta?: unknown, is_user = false): STMessage {
  return { name: is_user ? 'U' : 'AI', is_user, is_system: false, mes: '', ...(horae_meta ? { horae_meta } : {}) } as STMessage;
}

const chat: STMessage[] = [
  msg({ _deletedNpcs: ['路人甲'] }),
  msg({
    npcs: {
      范道允: { appearance: '銀白短髮/紫眼', gender: '男', age: '24', job: '偶像', relationship: '男朋友' },
      路人甲: { appearance: '光頭' },
      阿黛爾: { appearance: '銀色短髮', gender: '女' },
    },
    costumes: { 沐予凝: '白色睡衣', 范道允: '黑色外套' },
    scene: { characters_present: ['沐予凝', '范道允'] },
  }),
  msg(undefined, true),
  msg({
    npcs: { 范道允: { appearance: '銀白短髮/紫眼/黑眼圈', gender: '女' } },
    costumes: { 沐予凝: '雪紡襯衫（凌亂）', 范道允: '運動長褲（褪至大腿）' },
    mood: { 范道允: '動情' },
  }),
  msg({ _skipHorae: true, costumes: { 沐予凝: '不該被讀到' } }),
];

describe('readHoraeMemory', () => {
  it('直接讀 horae_meta:著裝取最新一筆,NPC 逐欄位合併(性別只在未設定時填入)', () => {
    const memory = readHoraeMemory(chat, 4, '', '沐予凝');
    expect(memory?.text).toContain('主角:著裝:雪紡襯衫（凌亂）');
    expect(memory?.text).toContain('范道允(男·24·偶像) —— 與主角:男朋友 〔外貌:銀白短髮/紫眼/黑眼圈;著裝:運動長褲（褪至大腿）;狀態:動情〕');
    expect(memory?.text).not.toContain('不該被讀到');
  });

  it('角色庫已建檔的角色不送外貌', () => {
    const memory = readHoraeMemory(chat, 4, '', '沐予凝', new Set(['范道允']));
    expect(memory?.text).toContain('范道允(男·24·偶像) —— 與主角:男朋友 〔著裝:運動長褲（褪至大腿）;狀態:動情〕');
    expect(memory?.text).not.toContain('黑眼圈');
  });

  it('不在場的 NPC 只在正文寫到名字時才送;在 Horae 刪掉的 NPC 一律不送', () => {
    expect(readHoraeMemory(chat, 4, '', '沐予凝')?.text).not.toContain('阿黛爾');
    expect(readHoraeMemory(chat, 4, '阿黛爾推門進來', '沐予凝')?.text).toContain('阿黛爾(女) 〔外貌:銀色短髮〕');
    expect(readHoraeMemory(chat, 4, '路人甲走過', '沐予凝')?.text).not.toContain('路人甲');
  });

  it('只讀到目標樓為止', () => {
    expect(readHoraeMemory(chat, 1, '', '沐予凝')?.text).toContain('主角:著裝:白色睡衣');
  });

  it('沒有 Horae 記錄時返回 null', () => {
    expect(readHoraeMemory([msg(), msg(undefined, true)], 1, '', '沐予凝')).toBeNull();
  });
});

describe('readHoraeAppearance', () => {
  it('不論是否在場都能取到外貌', () => {
    expect(readHoraeAppearance(chat, '阿黛爾')).toBe('銀色短髮');
    expect(readHoraeAppearance(chat, '沒這個人')).toBe('');
  });
});
