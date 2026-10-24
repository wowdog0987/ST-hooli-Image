import type { ChatMsg } from '@/api/client';
import { presetFamily, templateSupportsNegative } from '@/backends/comfyTemplates';
import { getWorkflowPlaceholders } from '@/backends/comfyui';
import { isNai5, naiSupportsCharacterPrompts } from '@/backends/nai';
import {
  cleanHistoryText,
  prepareTargetText,
  type PreparedTargetText,
} from '@/autoTag/clean';
import type { HoraeMemoryContext } from '@/autoTag/horaeMemory';
import { formatSceneBlock, readFloorScene } from '@/autoTag/sceneMemory';
import { formatWorldSettingBlock } from '@/state/worldSetting';
import { isAiStoryMessage, isStoryMessage, type STContext } from '@/st/context';
import type { AutoTagSettings } from '@/state/settings';
import {
  activeComfyPreset,
  DEFAULT_COMFY_NL_SPEC,
  DEFAULT_COMFY_SPEC,
  DEFAULT_COMFY_THINKING,
  DEFAULT_JAILBREAK_PROMPT,
  DEFAULT_NAI_SPEC,
  DEFAULT_NAI_THINKING,
  DEFAULT_NAI_V5_SPEC,
  DEFAULT_NAI_V5_THINKING,
  DEFAULT_PREFILL_PROMPT,
  settings,
} from '@/state/settings';

function backendPromptSpec(options: AutoTagSettings, nlOn: boolean, naiCharPromptsOn: boolean): string {
  if (settings.defaultBackend === 'comfyui') {
    const template = (options.prompts?.comfySpec ?? '').trim() || DEFAULT_COMFY_SPEC;
    const nlSpec = nlOn ? DEFAULT_COMFY_NL_SPEC : '';
    const resolved = template.includes('{{nl}}')
      ? template.replaceAll('{{nl}}', nlSpec)
      : nlSpec
        ? `${template}\n\n${nlSpec}`
        : template;
    return resolved.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (settings.defaultBackend === 'nai') {
    return naiCharPromptsOn
      ? (options.prompts?.naiV5Spec ?? '').trim() || DEFAULT_NAI_V5_SPEC
      : (options.prompts?.naiSpec ?? '').trim() || DEFAULT_NAI_SPEC;
  }
  return '';
}

function backendThinkingPrompt(options: AutoTagSettings, naiCharPromptsOn: boolean): string {
  if (settings.defaultBackend === 'nai') {
    return naiCharPromptsOn
      ? (options.prompts?.naiV5Thinking ?? '').trim() || DEFAULT_NAI_V5_THINKING
      : (options.prompts?.naiThinking ?? '').trim() || DEFAULT_NAI_THINKING;
  }
  return (options.prompts?.comfyThinking ?? '').trim() || DEFAULT_COMFY_THINKING;
}

export function recentFloors(context: STContext, targetFloor: number, count: number): number[] {
  const aiFloors: number[] = [];
  for (let floor = 0; floor <= targetFloor; floor += 1) {
    const message = context.chat[floor];
    if (isAiStoryMessage(message)) aiFloors.push(floor);
  }
  const keep = Math.max(1, Math.floor(count) || 1);
  const start = aiFloors[Math.max(0, aiFloors.length - keep)] ?? targetFloor;
  const floors: number[] = [];
  for (let floor = start; floor <= targetFloor; floor += 1) {
    if (isStoryMessage(context.chat[floor])) floors.push(floor);
  }
  return floors;
}

function roleLabel(context: STContext, floor: number): string {
  const message = context.chat[floor];
  if (message.is_user) return `user（${message.name || context.name1 || 'User'}）`;
  return `assistant（${message.name || context.name2 || 'Assistant'}）`;
}

export async function buildAutoTagMessages(
  context: STContext,
  targetFloor: number,
  options: AutoTagSettings,
  memory: HoraeMemoryContext | null,
  preparedTargetOverride?: PreparedTargetText,
  library?: string | null,
  taskNote?: string,
): Promise<ChatMsg[]> {
  const target = context.chat[targetFloor];
  const preparedTarget =
    preparedTargetOverride ??
    prepareTargetText(target.mes, settings.excludes.customStripTags);
  const previous = recentFloors(context, targetFloor, options.contextMessages)
    .filter(floor => floor !== targetFloor)
    .map(
      floor =>
        `--- 上下文｜${roleLabel(context, floor)} ---\n${cleanHistoryText(
          context.chat[floor].mes,
          settings.excludes.customStripTags,
        )}`,
    )
    .join('\n\n');
  const memoryText = memory ? memory.text : '角色參考：Horae 本次未提供。';

  const comfyOn = settings.defaultBackend === 'comfyui';
  const naiCharPromptsOn =
    settings.defaultBackend === 'nai' && naiSupportsCharacterPrompts(settings.nai.model);
  const comfyPreset = comfyOn ? activeComfyPreset() : null;
  // CLIP 系(Checkpoint)每 75 token 切一段、越前面越強,要排順序、控長度
  const clipOn = !!comfyPreset && presetFamily(comfyPreset) === 'checkpoint';
  // 自然語言只在會被送出的地方要:ComfyUI 開了「生成自然語言」,或 NAI V5 的 Base。
  // NAI 4.5 送的是純 tag(V4.5 對自然語言只算部分支援),寫了也是白燒 token。
  const naiNlOn = naiCharPromptsOn && isNai5(settings.nai.model);
  // 簡易模式的 Checkpoint 不送句子(見 composePositive),開著也不寫
  const comfyNlOn =
    !!comfyPreset?.naturalLanguage && !(comfyPreset.mode === 'simple' && clipOn);
  const nlOn = comfyNlOn || naiNlOn;
  
  let negativeOn = false;
  if (comfyPreset) {
    if (comfyPreset.mode === 'simple') {
      negativeOn = templateSupportsNegative(comfyPreset.simple.template);
    } else if (presetFamily(comfyPreset) !== 'flux' && comfyPreset.workflow.trim()) {
      try {
        negativeOn = getWorkflowPlaceholders(comfyPreset.workflow).includes('negative_prompt');
      } catch {
        // Invalid workflow; skip negative prompts
      }
    }
  }

  const maxImages = Math.max(1, Math.floor(Number(options.maxImages)) || 1);

  const spec = backendPromptSpec(options, nlOn, naiCharPromptsOn);

  const messages: ChatMsg[] = [];
  const jailbreak = (options.prompts?.jailbreak ?? '').trim() || DEFAULT_JAILBREAK_PROMPT;
  if (jailbreak) messages.push({ role: 'system', content: jailbreak });
  if (spec) messages.push({ role: 'system', content: spec });

  // 鍵名必須寫死:protocol.ts 只認 position / tag / nl / characters / negative / size,
  // 不給 schema 時模型會自創 instruction / prompt 之類的鍵,整次解析失敗(副 API 常見)。
  const imageSchema = naiCharPromptsOn
    ? `{"position":"P3","tag":"<Base: shot, angle, scene, lighting>",${naiNlOn ? '"nl":"<English: who is where, who touches what, camera>",' : ''}"characters":[{"name":"<exact name>","tag":"<library fields, clothing, expression, pose, action>"}],"size":"<portrait|landscape>"}`
    : `{"position":"P3","tag":"<danbooru tags>",${nlOn ? '"nl":"<English description>",' : ''}${negativeOn ? '"negative":"<conflict-removal tags>",' : ''}"size":"<portrait|landscape>"}`;
  const minImages = Math.max(0, Math.floor(Number(options.minImages)) || 0);

  const coreRules = `You are an image prompt writer.

Return exactly one JSON object (after the <thinking> block):
{"images":[${imageSchema}],"changes":[]}

Rules:
1. images count: ${Math.min(minImages, maxImages)}–${maxImages}
2. Generate images ONLY when:
- clear visible action or interaction
- AND (strong emotion OR concrete environment)
${minImages > 0 ? `If no moment fully qualifies, still pick the most visual moment(s) to reach ${minImages}.` : 'Otherwise return {"images":[],"changes":[]}'}
3. Each image is one moment of the story (a moment, not a summary of the reply), built in two layers:
- ongoing state: what is still true at that line — the activity in progress, each character's posture and body arrangement, where they are. Carry it forward from earlier lines and from the context floors until the text ends or changes it.
- highlight: the action written at that line, added on top of the ongoing state (two people lying on the grass talking, then a kiss → they kiss while still lying on the grass).
Pick the most visual moment first, then the next most visual one. position: the ⟦Pn⟧ marker of the highlight's line; use only markers that appear in the target text.

4. Data sources:
- 【世界背景】: the era and region. Put 1–3 English era tags in Base (e.g. 18th century, rococo, historical), and write every garment, building and prop as that era's version: Horae / story text says WHAT is worn, 【世界背景】 says in WHICH era's style (e.g. 18th-century Rococo 禮服 → tailcoat, waistcoat, ascot, breeches for a man; frilled dress, corset, long dress for a woman).
- 【當前場景】: location, atmosphere, fixed scene features, time of day → background and lighting.
- 【角色參考】(Horae): each character's clothing for this turn (著裝) and temporary state — use it as written.
- 【角色固定外貌庫】: the authoritative fixed appearance.
- Target text: the moment to draw, its highlight action and emotion.
- Context floors (--- 上下文 ---): the ongoing state and scene leading into the target text.

5. Characters: list the characters visible in the frame, each name exactly as written in the library / story.
${naiCharPromptsOn ? 'Each character tag' : 'For each visible character, the tag'}, in this order: library fields copied verbatim → clothing (rule 6) → expression → body structure (rule 7).${naiCharPromptsOn ? '\nThe plugin adds the character count tags (1girl, 1boy…) to Base from the characters list.' : `
This backend takes ONE tag string for everyone. Start it with the count tags (1girl / 1boy / 2girls / 1girl, 1boy …; add hetero when a girl and a boy are together), then write each visible character's tags as one group in the order above, right after the count tags and before the scene. With two or more characters, bind every trait that could belong to anyone to that character's anchor (hair color + girl/boy): red dress on silver hair girl, silver hair girl smiling, black hair boy looking at another. Hair and eye colors stay plain as the anchors; what the characters share (the room, the light) is written once.`}

6. Clothing: write exactly the garments listed in that character's 著裝 (【角色參考】), each one as tags together with its state (凌亂 → disheveled clothes; 敞開 → open shirt; 退至大腿 → pants pull). Add no garment that is not listed. When no top is listed, the character is topless: write shirtless for a man, topless for a woman. Garments fully outside the shot may be left out.

7. Body structure — write it as concrete danbooru pose tags, in this order:
- posture: standing / sitting / leaning forward / lying on back …
- the limb that acts and where it touches: hand on another's cheek, hand on another's waist, leg up …
- gaze: looking at another / looking down / eye contact …${naiCharPromptsOn ? `
- interaction between two characters: write the same action tag on both sides with NAI prefixes — the actor gets source#, the receiver gets target#, a shared action gets mutual# on both. The text after the prefix is identical on both sides (source#kiss / target#kiss; source#hand on another's face / target#hand on another's face; mutual#hug / mutual#hug).` : ''}

8. Explicit scenes: when the ongoing state or the highlight is sexual, Base starts with nsfw and carries the act itself as tags (e.g. sex, vaginal, plus the position); each character's tag carries their own exposed body parts${naiCharPromptsOn ? ', and the act is paired with source# / target# like any interaction' : ''}. The highlight (a kiss, a bite, a look) is added to the act; the act stays in the tags.

9. Composition: write exactly one shot distance (never two) that frames the whole ongoing state and the highlight, plus an angle when it helps (from side, from above), following the shot and orientation rules of the backend specification.

10. Tag vocabulary: every tag is a short canonical danbooru tag (1–3 lowercase words) that exists on danbooru. Split a description into several canonical tags: "messy white chiffon shirt" → white shirt, disheveled clothes; "pants pulled down to thighs" → pants pull; "lying on table" → lying on back, on table.
Some English garment words mean something else as danbooru tags — habit is a nun's habit, so a riding habit becomes jacket, long skirt, ascot, riding boots. When a garment has no common danbooru tag, build it from basic garment tags (jacket, coat, long skirt, frilled dress, ascot, corset, boots).${nlOn ? '' : ' This model reads tags only, so every garment, pose and prop must be a tag it knows.'}
Emphasis, when needed: ${comfyOn ? '(tag:1.3); library weights written as 1.3::tag:: are converted by the plugin, copy them as written' : '1.3::tag:: (two colons on each side); copy library weights as written'}.
Base order: ${naiNlOn ? 'nsfw and the act (explicit scenes only) → the shared interaction and pose → era → scene → shot → angle → lighting; the most important content goes in the front half' : comfyOn ? 'count tags → each character as in rule 5 → nsfw and the act (explicit scenes only) → shared interaction → shot → angle → era → scene → lighting' : 'nsfw and the act (explicit scenes only) → shot → angle → era → scene → lighting, then each character as in rule 5'}.${clipOn ? ' This model reads the tag string in 75-token chunks and the first chunk counts most: keep the count tags and the characters at the front, keep each character\'s tags together, and keep the whole tag around 40 tags.' : ''}

11. Space budget: rules 5–9 stay complete. When a tag gets long, shorten atmosphere adjectives only.
${nlOn ? `
12. NL: ${naiNlOn ? 'Base nl only — one or two English sentences on the spatial arrangement, the interaction and the camera (who is where, who touches what), and the era-specific clothing named in plain words (e.g. an 18th-century riding outfit); appearance stays in the tags.' : 'natural English, one clause per spatial relation (who is where, who touches what); refer to each character by a short distinguishing trait (e.g. the black-haired girl).'}
` : ''}
size: "portrait" or "landscape", chosen by the orientation rules of the backend specification.
${negativeOn ? 'negative: tags that remove conflicts with the tag' + (nlOn ? ' and nl' : '') + '.\n' : ''}
changes: normally []. When a visible character has no entry in the 【角色固定外貌庫】, add
{"name":"<exact name>","field":"new","fields":{"sex":"1girl","hair":"...","eyes":"...","skin":"","body":"","extra":"","outfit":""}${nlOn ? ',"nl":"<one English appearance sentence>"' : ''}}
Fill fields only with drawable, permanent appearance (hair and eyes are required). Expression, emotion, injuries, tiredness, blush and sweat belong in this image's character tag; height numbers and personality words are left out.
`;

  messages.push({ role: 'system', content: coreRules });

  const thinking = backendThinkingPrompt(options, naiCharPromptsOn);
  if (thinking) messages.push({ role: 'system', content: thinking });

  const libraryBlock = library?.trim() || `【角色固定外貌庫】[system-maintained; currently empty]`;
  const taskBlock = taskNote?.trim() ? `${taskNote.trim()}\n\n` : '';
  // 世界背景(聊天級設定)與當前場景(只讀本樓 <horae> 結果)——取代世界書與整份 Horae 記憶
  const worldBlock = formatWorldSettingBlock();
  const sceneBlock = formatSceneBlock(readFloorScene(context.chat, targetFloor));
  const headBlocks = [worldBlock, sceneBlock].filter(Boolean).join('\n\n');
  const formatReminder = `【輸出格式】先 <thinking>…</thinking>,接著輸出純 JSON 物件:以 {"images": 開頭、以 } 結尾,只使用上方 schema 的鍵名;position 填目標正文行尾的 ⟦Pn⟧。`;
  const userContent = `${headBlocks ? `${headBlocks}\n\n` : ''}${memoryText}\n\n${libraryBlock}\n\n${taskBlock}${previous ? `${previous}\n\n` : ''}--- 目標正文｜${roleLabel(context, targetFloor)} ---\n${preparedTarget.promptText}\n\n${formatReminder}`;
  messages.push({ role: 'user', content: userContent });

  const prefill = (options.prompts?.prefill ?? '').trim() || DEFAULT_PREFILL_PROMPT;
  if (prefill) messages.push({ role: 'assistant', content: prefill });

  return messages;
}
