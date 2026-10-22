import { describe, expect, it } from 'vitest';

import { buildLibraryText } from '@/autoTag/charAnchors';
import { readFloorPresent } from '@/autoTag/sceneMemory';
import { fullPositivePrompt } from '@/backends/nai';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';
import { settings } from '@/state/settings';
import type { STMessage } from '@/st/context';

function entry(name: string, hair: string): CharTagEntry {
  return { name, fields: { ...emptyCharFields(), sex: '1boy', hair }, raw: '', nl: '', source: 'manual', desc: '', history: [] };
}

describe('角色庫只送在場角色的完整欄位', () => {
  const entries = [entry('范道允', 'silver hair'), entry('朴正民', 'short black hair'), entry('陆彦楷', 'pink hair')];

  it('在場的人帶完整欄位,其餘只列名字', () => {
    const text = buildLibraryText(entries, undefined, new Set(['范道允']));
    expect(text).toContain('- 范道允: 性別=1boy, 頭髮=silver hair');
    expect(text).not.toContain('short black hair');
    expect(text).toContain('已建檔(本次未判定在場;若入畫照常使用這個名字,不要重新建檔):朴正民、陆彦楷');
  });

  it('沒給在場名單時照舊全送', () => {
    expect(buildLibraryText(entries)).toContain('short black hair');
  });
});

describe('readFloorPresent', () => {
  const ai = (mes: string, horae_meta?: unknown) =>
    ({ name: 'AI', is_user: false, is_system: false, mes, ...(horae_meta ? { horae_meta } : {}) }) as STMessage;

  it('優先讀 Horae meta 的在場名單(全名,不受正文暱稱影響)', () => {
    const chat = [ai('阿允低頭吻她。', { scene: { characters_present: ['沐予凝', '范道允'] } })];
    expect(readFloorPresent(chat, 0)).toEqual(['沐予凝', '范道允']);
  });

  it('沒有 meta 時解析 <horae> 的 characters 行;本樓沒有就往回找', () => {
    const chat = [ai('前樓\n<horae>\ncharacters:沐予凝,范道允\n</horae>'), ai('阿允笑了。')];
    expect(readFloorPresent(chat, 1)).toEqual(['沐予凝', '范道允']);
  });
});

describe('NAI 送出的正向提示詞', () => {
  it('4.5 純 tag,V5 把 Base nl 接在畫面 tag 之後', () => {
    const nai = { ...settings.nai, qualityTags: 'best quality', artistPresets: [], activeArtistId: '' };
    expect(fullPositivePrompt({ ...nai, model: 'nai-diffusion-4-5-full' }, '1girl, kitchen', 'She sits on the counter.')).toBe(
      '1girl, kitchen, best quality',
    );
    expect(fullPositivePrompt({ ...nai, model: 'nai-diffusion-5-full' }, '1girl, kitchen', 'She sits on the counter.')).toBe(
      '1girl, kitchen, She sits on the counter., best quality',
    );
  });
});
