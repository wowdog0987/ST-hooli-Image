import { describe, expect, it } from 'vitest';

import {
  buildSimpleWorkflow,
  composePositive,
  normalizeSimpleConfig,
  simpleDefaults,
  templateSupportsNegative,
  validateSimpleConfig,
  type ComfySimpleConfig,
  type SimpleWorkflowNode,
} from '@/backends/comfyTemplates';

const VALUES = { prompt: '1girl, silver hair', seed: 42, width: 832, height: 1216 };

function config(patch: Partial<ComfySimpleConfig>): ComfySimpleConfig {
  return { ...simpleDefaults(), ...patch };
}

function node(workflow: Record<string, SimpleWorkflowNode>, id: string): SimpleWorkflowNode {
  const found = workflow[id];
  if (!found) throw new Error(`node ${id} missing`);
  return found;
}

describe('validateSimpleConfig', () => {
  it('未選模型時報錯', () => {
    expect(validateSimpleConfig(simpleDefaults())).toContain('模型');
  });

  it('flux/anima 缺 VAE 或 CLIP 時報對應欄位;checkpoint 外接 VAE 可留空', () => {
    const flux = { ...simpleDefaults('flux'), model: 'flux1-dev.safetensors' };
    expect(validateSimpleConfig(flux)).toContain('VAE');
    expect(validateSimpleConfig({ ...flux, vae: 'ae.safetensors' })).toContain('T5-XXL');
    expect(validateSimpleConfig({ ...flux, vae: 'ae.safetensors', clip1: 't5xxl_fp8.safetensors' })).toContain('CLIP-L');
    expect(
      validateSimpleConfig({ ...flux, vae: 'ae.safetensors', clip1: 't5xxl_fp8.safetensors', clip2: 'clip_l.safetensors' }),
    ).toBeNull();

    const anima = { ...simpleDefaults('anima'), model: 'anima.safetensors', vae: 'qwen_image_vae.safetensors' };
    expect(validateSimpleConfig(anima)).toContain('Qwen');
    expect(validateSimpleConfig({ ...anima, clip1: 'qwen_2.5_vl_7b.safetensors' })).toBeNull();

    expect(validateSimpleConfig(config({ model: 'illustrious.safetensors' }))).toBeNull();
  });
});

describe('buildSimpleWorkflow - checkpoint', () => {
  const simple = config({ model: 'illustrious_xl.safetensors', positive: 'masterpiece, best quality', negative: 'worst quality' });

  it('組出經典五節點鏈路,正負面按「固定+生成」拼接', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'extra people' });
    expect(node(wf, '1').class_type).toBe('CheckpointLoaderSimple');
    expect(node(wf, '1').inputs.ckpt_name).toBe('illustrious_xl.safetensors');
    expect(node(wf, '3').inputs.text).toBe('masterpiece, best quality, 1girl, silver hair');
    expect(node(wf, '4').inputs.text).toBe('worst quality, extra people');
    expect(node(wf, '5').inputs).toMatchObject({ width: 832, height: 1216 });
    expect(node(wf, '6').inputs).toMatchObject({
      seed: 42,
      steps: 28,
      cfg: 5,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      model: ['1', 0],
      positive: ['3', 0],
      negative: ['4', 0],
    });
    // 無外接 VAE → 用 checkpoint 內建(槽位 2)
    expect(node(wf, '7').inputs.vae).toEqual(['1', 2]);
    expect(node(wf, '8').class_type).toBe('SaveImage');
  });

  it('Checkpoint 只吃 tag:有 nl 也不送,免得擠掉 tag', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, nl: 'A girl with silver hair.' });
    expect(node(wf, '3').inputs.text).toBe('masterpiece, best quality, 1girl, silver hair');
  });

  it('Flux 句子在前、tag 在後;Anima tag 在前、句子在後', () => {
    const values = { ...VALUES, nl: 'A girl with silver hair.' };
    const base = { ...simple, positive: '' };
    expect(composePositive({ ...base, template: 'flux' }, values)).toBe('A girl with silver hair., 1girl, silver hair');
    expect(composePositive({ ...base, template: 'anima' }, values)).toBe('1girl, silver hair, A girl with silver hair.');
  });

  it('固定詞留空時只剩生成內容(不多逗號)', () => {
    const wf = buildSimpleWorkflow(config({ model: 'm.safetensors' }), VALUES);
    expect(node(wf, '3').inputs.text).toBe('1girl, silver hair');
    expect(node(wf, '4').inputs.text).toBe('');
  });

  it('外接 VAE 走 VAELoader;LoRA 串聯在底模與編碼之間', () => {
    const wf = buildSimpleWorkflow(
      config({
        model: 'm.safetensors',
        vae: 'fix_vae.safetensors',
        loras: [
          { name: 'style.safetensors', strength: 0.8 },
          { name: '', strength: 1 }, // 未填完的行被忽略
          { name: 'detail.safetensors', strength: 0.5 },
        ],
      }),
      VALUES,
    );
    expect(node(wf, '2').class_type).toBe('VAELoader');
    expect(node(wf, '7').inputs.vae).toEqual(['2', 0]);
    expect(node(wf, '300').inputs).toMatchObject({ lora_name: 'style.safetensors', strength_model: 0.8, model: ['1', 0], clip: ['1', 1] });
    expect(node(wf, '301').inputs).toMatchObject({ lora_name: 'detail.safetensors', model: ['300', 0], clip: ['300', 1] });
    expect(node(wf, '6').inputs.model).toEqual(['301', 0]);
    expect(node(wf, '3').inputs.clip).toEqual(['301', 1]);
    expect(wf['302']).toBeUndefined();
  });
});

describe('buildSimpleWorkflow - flux', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('flux'),
    model: 'flux1-dev.safetensors',
    vae: 'ae.safetensors',
    clip1: 't5xxl_fp8.safetensors',
    clip2: 'clip_l.safetensors',
  };

  it('UNet + DualCLIP + ae,負面恆空、cfg 恆 1、走 FluxGuidance', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'ignored' });
    expect(node(wf, '1').class_type).toBe('UNETLoader');
    expect(node(wf, '2').inputs).toMatchObject({ clip_name1: 't5xxl_fp8.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' });
    expect(node(wf, '5').inputs.text).toBe('');
    expect(node(wf, '6').inputs).toMatchObject({ guidance: 3.5, conditioning: ['4', 0] });
    expect(node(wf, '8').inputs).toMatchObject({ cfg: 1, positive: ['6', 0], negative: ['5', 0] });
    expect(node(wf, '7').class_type).toBe('EmptySD3LatentImage');
  });

  it('guidance = 1 時跳過 FluxGuidance,直連編碼輸出', () => {
    const wf = buildSimpleWorkflow({ ...simple, guidance: 1 }, VALUES);
    expect(wf['6']).toBeUndefined();
    expect(node(wf, '8').inputs.positive).toEqual(['4', 0]);
  });

  it('GGUF 用 UnetLoaderGGUF;LoRA 只掛 model(LoraLoaderModelOnly)', () => {
    const wf = buildSimpleWorkflow(
      { ...simple, gguf: true, loras: [{ name: 'flux_lora.safetensors', strength: 1 }] },
      VALUES,
    );
    expect(node(wf, '1').class_type).toBe('UnetLoaderGGUF');
    expect(node(wf, '300').class_type).toBe('LoraLoaderModelOnly');
    expect(node(wf, '300').inputs).not.toHaveProperty('clip');
    expect(node(wf, '8').inputs.model).toEqual(['300', 0]);
  });
});

describe('buildSimpleWorkflow - anima', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('anima'),
    model: 'anima_pencil.safetensors',
    vae: 'qwen_image_vae.safetensors',
    clip1: 'qwen_2.5_vl_7b.safetensors',
  };

  it('CLIPLoader 用 qwen_image 型別,模型過 ModelSamplingAuraFlow(shift 可調)', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'blurry' });
    expect(node(wf, '2').inputs).toMatchObject({ clip_name: 'qwen_2.5_vl_7b.safetensors', type: 'qwen_image' });
    expect(node(wf, '6').inputs).toMatchObject({ shift: 3, model: ['1', 0] });
    expect(node(wf, '8').inputs).toMatchObject({ model: ['6', 0], cfg: 4 });
    expect(node(wf, '5').inputs.text).toBe('blurry');
  });

  it('LoRA 鏈尾接進 AuraFlow 而不是取樣器', () => {
    const wf = buildSimpleWorkflow({ ...simple, loras: [{ name: 'a.safetensors', strength: 1 }] }, VALUES);
    expect(node(wf, '6').inputs.model).toEqual(['300', 0]);
  });
});

describe('buildSimpleWorkflow - 尺寸', () => {
  it('尺寸無效時報錯(簡易模式的畫布節點是必建的,沒有「工作流寫死尺寸」的豁免)', () => {
    const simple = config({ model: 'm.safetensors' });
    expect(() => buildSimpleWorkflow(simple, { ...VALUES, width: 0 })).toThrow('尺寸');
    expect(() => buildSimpleWorkflow(simple, { ...VALUES, height: 0 })).toThrow('尺寸');
  });
});

describe('normalizeSimpleConfig', () => {
  it('空輸入給 checkpoint 預設值', () => {
    expect(normalizeSimpleConfig(undefined)).toEqual(simpleDefaults());
  });

  it('非法 template 回 checkpoint;髒字段逐項歸位', () => {
    const normalized = normalizeSimpleConfig({
      template: 'qwen-whatever',
      model: 42,
      steps: 'not a number',
      loras: [{ name: 'a.safetensors', strength: '0.7' }, null, 'junk'],
    });
    expect(normalized.template).toBe('checkpoint');
    expect(normalized.model).toBe('');
    expect(normalized.steps).toBe(28);
    expect(normalized.loras).toEqual([
      { name: 'a.safetensors', strength: 0.7 },
      { name: '', strength: 1 },
      { name: '', strength: 1 },
    ]);
  });

  it('合法 template 的取樣引數按該模板預設值兜底', () => {
    expect(normalizeSimpleConfig({ template: 'flux' })).toEqual(simpleDefaults('flux'));
    expect(normalizeSimpleConfig({ template: 'anima' }).shift).toBe(3);
  });
});

describe('templateSupportsNegative', () => {
  it('flux 無真實負面輸入,其餘有', () => {
    expect(templateSupportsNegative('flux')).toBe(false);
    expect(templateSupportsNegative('checkpoint')).toBe(true);
    expect(templateSupportsNegative('anima')).toBe(true);
  });
});
