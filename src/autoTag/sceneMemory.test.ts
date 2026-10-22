import { describe, expect, it } from 'vitest';

import { formatSceneBlock, parseHoraeBlock, readFloorScene } from '@/autoTag/sceneMemory';
import type { STMessage } from '@/st/context';

function ai(mes: string, horae_meta?: unknown): STMessage {
  return { name: 'AI', is_user: false, is_system: false, mes, ...(horae_meta ? { horae_meta } : {}) } as STMessage;
}
const user: STMessage = { name: 'U', is_user: true, is_system: false, mes: '嗯' };

describe('readFloorScene', () => {
  it('只讀本樓 horae_meta 的場景與時刻,不帶物品/NPC', () => {
    const chat = [
      ai('開場'),
      ai('正文', {
        timestamp: { story_date: '2025/1/1', story_time: '16:05' },
        scene: { location: '皇宮·休息室', atmosphere: '曖昧', scene_desc: '天鵝絨貴妃榻,窗簾厚重' },
        items: { 提拉米蘇: {} },
        npcs: { 卡萊爾: {} },
      }),
    ];
    const scene = readFloorScene(chat, 1);
    expect(scene).toEqual({
      location: '皇宮·休息室',
      atmosphere: '曖昧',
      sceneDesc: '天鵝絨貴妃榻,窗簾厚重',
      time: '16:05',
    });
    const block = formatSceneBlock(scene);
    expect(block).not.toContain('2025');
    expect(block).not.toContain('提拉米蘇');
  });

  it('本樓沒有 meta 時解析原文 <horae>,多地點取最後一個', () => {
    const meta = parseHoraeBlock(
      '正文\n<horae>\ntime:2025/1/1 15:28\nlocation:皇宮·大廳\nscene_desc:挑高大廳\nlocation:皇宮·休息室\natmosphere:緊張\n</horae>',
    );
    expect(meta?.scene).toEqual({ location: '皇宮·休息室', atmosphere: '緊張', scene_desc: '' });
    expect(meta?.timestamp?.story_time).toBe('15:28');
  });

  it('本樓漏寫地點 → 往回找最近一樓;場景特徵只查該地點的場景記憶', () => {
    const chat = [
      ai('首樓', {
        locationMemory: {
          '皇宮·休息室': { desc: '位於西側長廊盡頭' },
          '皇宮·大廳': { desc: '不該出現' },
        },
      }),
      ai('前樓', { scene: { location: '皇宮·休息室', atmosphere: '曖昧' } }),
      user,
      ai('目標樓,無 horae'),
    ];
    expect(readFloorScene(chat, 3)).toEqual({
      location: '皇宮·休息室',
      atmosphere: '曖昧',
      sceneDesc: '位於西側長廊盡頭',
      time: '',
    });
  });

  it('完全沒有 Horae 記錄 → null', () => {
    expect(readFloorScene([ai('純正文')], 0)).toBeNull();
    expect(formatSceneBlock(null)).toBe('');
  });
});
