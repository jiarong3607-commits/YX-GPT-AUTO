import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAIProviderRouter } from './openai-provider-router.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const env = readEnvFile();
const port = Number(process.env.PORT || env.PORT || 3000);
const getEnv = name => process.env[name] || env[name] || '';
const internalAccessCode = process.env.INTERNAL_ACCESS_CODE || env.INTERNAL_ACCESS_CODE || '';
const demoImageMode = String(process.env.DEMO_IMAGE_MODE || env.DEMO_IMAGE_MODE || '').toLowerCase() === 'true';
const dataDir = path.resolve(__dirname, process.env.DATA_DIR || env.DATA_DIR || 'data');
const outputsDir = path.resolve(__dirname, process.env.OUTPUTS_DIR || env.OUTPUTS_DIR || 'outputs');
const runtimeEventsFile = path.join(dataDir, 'runtime-events.jsonl');
const openAiProviderRouter = createOpenAIProviderRouter({ getEnv });
const sessions = new Map();
const sessionMaxAgeMs = 8 * 60 * 60 * 1000;

const batchLimits = {
  maxMaterials: parsePositiveInt(process.env.BATCH_MAX_MATERIALS || env.BATCH_MAX_MATERIALS, 10),
  maxOutputs: parsePositiveInt(process.env.BATCH_MAX_OUTPUTS || env.BATCH_MAX_OUTPUTS, 30),
  maxPerMaterial: parsePositiveInt(process.env.BATCH_MAX_PER_MATERIAL || env.BATCH_MAX_PER_MATERIAL, 4),
  maxPromptChars: parsePositiveInt(process.env.BATCH_MAX_PROMPT_CHARS || env.BATCH_MAX_PROMPT_CHARS, 4000),
  maxImageBytes: parsePositiveInt(process.env.BATCH_MAX_IMAGE_BYTES || env.BATCH_MAX_IMAGE_BYTES, 8 * 1024 * 1024),
  maxRequestBytes: parsePositiveInt(process.env.BATCH_MAX_REQUEST_BYTES || env.BATCH_MAX_REQUEST_BYTES, 35 * 1024 * 1024),
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
};

const fleets = {
  aurora: { id: 'aurora', name: '极光车队', channel: '极光车队 · 适合创意插画' },
  nebula: { id: 'nebula', name: '星云车队', channel: '星云车队 · 适合科幻海报' },
  pixel: { id: 'pixel', name: '像素车队', channel: '像素车队 · 适合头像与贴纸' },
};

const allowedSizes = new Set(['1024x1024', '1536x1024', '1024x1536']);
const allowedQualities = new Set(['auto', 'low', 'medium', 'high']);
const allowedImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const styleLabels = {
  natural: '自然写实',
  vivid: '鲜艳夸张',
  anime: '动漫插画',
  poster: '电影海报',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/session') {
      handleSessionStatus(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      await handleLogin(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      handleLogout(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/generate-image') {
      await handleImageGeneration(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/batch-generate') {
      await handleBatchGeneration(req, res);
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('服务器错误：', error.message);
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, error.statusCode || 500, { error: '服务器开小差了，请稍后再试。' });
  }
});

server.listen(port, () => {
  console.log(`GPT 车队图片生成网页已启动：http://localhost:${port}`);
  const providerSummary = openAiProviderRouter.getSummary();
  console.info('[provider-router]', JSON.stringify({
    mode: providerSummary.mode,
    providerIds: providerSummary.providerIds,
  }));
  if (demoImageMode) {
    console.log('当前为演示模式：后端会返回本地占位图片，不会调用外部接口。');
  }
});

function handleSessionStatus(req, res) {
  sendJson(res, 200, { authenticated: Boolean(getSession(req)) });
}

async function handleLogin(req, res) {
  if (!isInternalAccessConfigured()) {
    sendJson(res, 503, { error: '请先在服务端配置 INTERNAL_ACCESS_CODE。' });
    return;
  }

  let payload;
  try {
    const body = await readRequestBody(req);
    payload = JSON.parse(body || '{}');
  } catch {
    sendJson(res, 400, { error: '请求格式不正确。' });
    return;
  }

  if (payload.accessCode !== internalAccessCode) {
    console.info('[access]', JSON.stringify({ result: 'login-failed', at: new Date().toISOString() }));
    sendJson(res, 401, { error: '访问码不正确，请联系内部负责人。' });
    return;
  }

  const sessionId = randomUUID();
  sessions.set(sessionId, { createdAt: Date.now(), expiresAt: Date.now() + sessionMaxAgeMs });
  res.setHeader('Set-Cookie', buildSessionCookie(sessionId));
  console.info('[access]', JSON.stringify({ result: 'login-success', at: new Date().toISOString() }));
  sendJson(res, 200, { authenticated: true });
}

function handleLogout(req, res) {
  const sessionId = getCookie(req, 'gpt_auto_session');
  if (sessionId) sessions.delete(sessionId);
  res.setHeader('Set-Cookie', 'gpt_auto_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  sendJson(res, 200, { authenticated: false });
}

async function handleImageGeneration(req, res) {
  if (!getSession(req)) {
    sendJson(res, 401, { error: '请先完成内部访问验证。' });
    return;
  }

  let payload;
  try {
    const body = await readRequestBody(req);
    payload = JSON.parse(body || '{}');
  } catch {
    await recordRuntimeEvent({ eventType: 'single_image', result: 'error', errorType: 'bad_request' });
    sendJson(res, 400, { error: '请求格式不正确，请重新输入提示词。' });
    return;
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  const fleet = fleets[payload.fleetId] || fleets.aurora;
  const size = allowedSizes.has(payload.size) ? payload.size : '1024x1024';
  const quality = allowedQualities.has(payload.quality) ? payload.quality : 'auto';
  const style = Object.hasOwn(styleLabels, payload.style) ? payload.style : 'natural';
  const runtimeMeta = {
    eventType: 'single_image',
    fleetId: fleet.id,
    fleetName: fleet.name,
    size,
    quality,
    style,
    promptLength: prompt.length,
  };

  if (prompt.length < 3) {
    await recordRuntimeEvent({ ...runtimeMeta, result: 'error', errorType: 'invalid_prompt' });
    sendJson(res, 400, { error: '请输入至少 3 个字的图片提示词。' });
    return;
  }

  if (demoImageMode) {
    await recordRuntimeEvent({ ...runtimeMeta, result: 'success', errorType: '', mode: 'demo' });
    sendJson(res, 200, {
      imageUrl: buildDemoImageDataUrl(prompt, fleet.name, styleLabels[style]),
      fleet: fleet.name,
      runtime: { ...runtimeMeta, result: 'success', mode: 'demo' },
    });
    return;
  }

  const enhancedPrompt = [
    `主题：${prompt}`,
    `车队频道：${fleet.channel}`,
    `画面风格：${styleLabels[style]}`,
    '请生成清晰、有细节、适合作为课程展示的高质量图片。',
  ].join('\n');

  try {
    const providerResult = await openAiProviderRouter.request('/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: enhancedPrompt,
        size,
        quality,
        n: 1,
      }),
    });

    const data = await providerResult.response.json().catch(() => ({}));

    const imageBase64 = data?.data?.[0]?.b64_json;
    if (!imageBase64) {
      await recordRuntimeEvent({
        ...runtimeMeta,
        result: 'error',
        errorType: 'empty_image',
        mode: 'openai',
        providerId: providerResult.providerId,
        providerStatus: providerResult.providerStatus,
        providerFailoverCount: providerResult.attempts.length,
      });
      sendJson(res, 502, { error: '图片生成服务没有返回可用结果，请稍后再试。' });
      return;
    }

    await recordRuntimeEvent({
      ...runtimeMeta,
      result: 'success',
      errorType: '',
      mode: 'openai',
      providerId: providerResult.providerId,
      providerStatus: providerResult.providerStatus,
      providerFailoverCount: providerResult.attempts.length,
    });
    sendJson(res, 200, {
      imageUrl: `data:image/png;base64,${imageBase64}`,
      fleet: fleet.name,
      runtime: { ...runtimeMeta, result: 'success', mode: 'openai' },
    });
  } catch (error) {
    await recordRuntimeEvent({
      ...runtimeMeta,
      result: 'error',
      errorType: normalizeErrorType(error),
      mode: 'openai',
      providerId: error.providerId || '',
      providerStatus: error.providerStatus || 0,
      providerFailoverCount: error.providerAttempts?.length || 0,
    });
    sendJson(res, error.statusCode || 502, { error: publicImageErrorMessage(error) });
  }
}

async function handleBatchGeneration(req, res) {
  if (!getSession(req)) {
    sendJson(res, 401, { error: '请先完成内部访问验证。' });
    return;
  }

  let payload;
  try {
    const body = await readRequestBody(req, batchLimits.maxRequestBytes);
    payload = JSON.parse(body || '{}');
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.statusCode === 413 ? '批量请求过大，请减少图片数量或压缩图片。' : '批量请求格式不正确。' });
    return;
  }

  let batch;
  try {
    batch = prepareBatch(payload);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
    return;
  }

  const outputTarget = await createBatchOutputTarget(payload.outputLabel);
  const usedFileNames = new Set();
  const summary = { success: 0, failed: 0 };

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  writeNdjson(res, {
    type: 'plan',
    batchId: outputTarget.batchId,
    mode: demoImageMode ? 'demo' : 'openai',
    outputDir: outputTarget.relativeDir,
    totalMaterials: batch.materials.length,
    perMaterialCount: batch.perMaterialCount,
    plannedOutputs: batch.plannedOutputs,
    countSource: batch.countSource,
    warning: batch.warning,
    limits: {
      maxMaterials: batchLimits.maxMaterials,
      maxOutputs: batchLimits.maxOutputs,
      maxPerMaterial: batchLimits.maxPerMaterial,
    },
  });

  for (let materialIndex = 0; materialIndex < batch.materials.length; materialIndex += 1) {
    const material = batch.materials[materialIndex];
    for (let sequence = 1; sequence <= batch.perMaterialCount; sequence += 1) {
      const progressBase = {
        type: 'progress',
        batchId: outputTarget.batchId,
        currentMaterialIndex: materialIndex + 1,
        totalMaterials: batch.materials.length,
        materialName: material.safeName,
        baseName: batch.baseImage.safeName,
        sequence,
        perMaterialCount: batch.perMaterialCount,
      };

      try {
        const generation = await generateBatchImage({
          prompt: batch.prompt,
          material,
          baseImage: batch.baseImage,
          size: batch.size,
          quality: batch.quality,
          style: batch.style,
          sequence,
        });
        const output = await saveGeneratedImage({
          imageDataUrl: generation.imageDataUrl,
          materialName: material.safeName,
          baseName: batch.baseImage.safeName,
          sequence,
          outputDir: outputTarget.absoluteDir,
          relativeDir: outputTarget.relativeDir,
          usedFileNames,
        });

        summary.success += 1;
        await recordRuntimeEvent({
          eventType: 'batch_image',
          batchId: outputTarget.batchId,
          materialName: material.safeName,
          baseName: batch.baseImage.safeName,
          outputPath: output.relativePath,
          size: batch.size,
          quality: batch.quality,
          style: batch.style,
          promptLength: batch.prompt.length,
          result: 'success',
          errorType: '',
          mode: demoImageMode ? 'demo' : 'openai',
          providerId: generation.providerId,
          providerStatus: generation.providerStatus,
          providerFailoverCount: generation.providerAttempts.length,
        });
        writeNdjson(res, { ...progressBase, status: 'success', outputPath: output.relativePath });
      } catch (error) {
        summary.failed += 1;
        const errorType = normalizeErrorType(error);
        await recordRuntimeEvent({
          eventType: 'batch_image',
          batchId: outputTarget.batchId,
          materialName: material.safeName,
          baseName: batch.baseImage.safeName,
          size: batch.size,
          quality: batch.quality,
          style: batch.style,
          promptLength: batch.prompt.length,
          result: 'error',
          errorType,
          mode: demoImageMode ? 'demo' : 'openai',
          providerId: error.providerId || '',
          providerStatus: error.providerStatus || 0,
          providerFailoverCount: error.providerAttempts?.length || 0,
        });
        writeNdjson(res, {
          ...progressBase,
          status: 'error',
          errorType,
          error: publicBatchErrorMessage(errorType),
        });
      }
    }
  }

  writeNdjson(res, {
    type: 'complete',
    batchId: outputTarget.batchId,
    outputDir: outputTarget.relativeDir,
    success: summary.success,
    failed: summary.failed,
    plannedOutputs: batch.plannedOutputs,
  });
  res.end();
}

function prepareBatch(payload) {
  const prompt = typeof payload.promptText === 'string' ? payload.promptText.trim() : '';
  if (prompt.length < 3) throwHttpError(400, '提示词 txt 内容太短，请至少提供 3 个字。');
  if (prompt.length > batchLimits.maxPromptChars) throwHttpError(400, `提示词过长，请控制在 ${batchLimits.maxPromptChars} 字以内。`);

  const rawMaterials = Array.isArray(payload.materials) ? payload.materials : [];
  if (rawMaterials.length < 1) throwHttpError(400, '请至少选择 1 张素材图。');
  if (rawMaterials.length > batchLimits.maxMaterials) throwHttpError(400, `素材图最多支持 ${batchLimits.maxMaterials} 张，请减少后再试。`);

  const baseImage = normalizeIncomingImage(payload.baseImage, '底板图');
  const materials = rawMaterials.map((image, index) => normalizeIncomingImage(image, `素材图 ${index + 1}`));
  const size = allowedSizes.has(payload.size) ? payload.size : '1024x1024';
  const quality = allowedQualities.has(payload.quality) ? payload.quality : 'auto';
  const style = Object.hasOwn(styleLabels, payload.style) ? payload.style : 'natural';
  const countPlan = parseGenerationCount(prompt);
  const plannedOutputs = rawMaterials.length * countPlan.perMaterialCount;
  if (plannedOutputs > batchLimits.maxOutputs) {
    throwHttpError(400, `本次计划生成 ${plannedOutputs} 张，超过安全上限 ${batchLimits.maxOutputs} 张。请减少素材数量或提示词中的生成数量。`);
  }

  return {
    prompt,
    materials,
    baseImage,
    size,
    quality,
    style,
    perMaterialCount: countPlan.perMaterialCount,
    plannedOutputs,
    countSource: countPlan.source,
    warning: countPlan.warning,
  };
}

function normalizeIncomingImage(file, label) {
  const safeName = sanitizeFileStem(file?.name || label) || sanitizeFileStem(label);
  const dataUrl = typeof file?.dataUrl === 'string' ? file.dataUrl : '';
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throwHttpError(400, `${label} 不是受支持的图片格式，请使用 PNG、JPG 或 WEBP。`);

  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  if (!allowedImageMimeTypes.has(mime)) throwHttpError(400, `${label} 图片格式不支持。`);

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (buffer.length < 1) throwHttpError(400, `${label} 文件为空。`);
  if (buffer.length > batchLimits.maxImageBytes) throwHttpError(400, `${label} 超过 ${Math.round(batchLimits.maxImageBytes / 1024 / 1024)}MB 上限。`);

  return {
    safeName,
    originalName: file?.name || label,
    mime,
    buffer,
  };
}

function parseGenerationCount(prompt) {
  const numberPattern = '([1-9]\\d?|[一二两三四五六七八九十])';
  const patterns = [
    new RegExp(`每(?:张|个)?(?:素材|图片|图)?(?:生成|出图|输出)?\\s*${numberPattern}\\s*张`, 'u'),
    new RegExp(`(?:生成数量|输出数量|出图数量|张数|数量)\\s*[:：=]?\\s*${numberPattern}\\s*张?`, 'u'),
    new RegExp(`(?:n|count)\\s*[:：=]\\s*${numberPattern}`, 'iu'),
    new RegExp(`${numberPattern}\\s*张(?:图|图片|结果)?`, 'u'),
  ];

  let requestedCount = 0;
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (!match) continue;
    requestedCount = parseCountToken(match[1]);
    if (requestedCount > 0) break;
  }

  if (!requestedCount) {
    return {
      perMaterialCount: 1,
      source: 'default',
      warning: '未能从提示词可靠解析生成数量，已按每张素材 1 张处理。',
    };
  }

  if (requestedCount > batchLimits.maxPerMaterial) {
    return {
      perMaterialCount: batchLimits.maxPerMaterial,
      source: 'capped',
      warning: `提示词要求每张 ${requestedCount} 张，已按安全上限限制为每张 ${batchLimits.maxPerMaterial} 张。`,
    };
  }

  return {
    perMaterialCount: requestedCount,
    source: 'prompt',
    warning: '',
  };
}

function parseCountToken(token) {
  const normalized = String(token || '').trim();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  const chineseNumbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return chineseNumbers[normalized] || 0;
}

async function createBatchOutputTarget(outputLabel) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const label = sanitizeFileStem(outputLabel || 'batch') || 'batch';
  const batchId = `${stamp}-${label}-${randomUUID().slice(0, 8)}`;
  const absoluteDir = path.join(outputsDir, batchId);
  const relativeDir = path.join('outputs', batchId).replace(/\\/g, '/');
  await mkdir(absoluteDir, { recursive: true });
  return { batchId, absoluteDir, relativeDir };
}

async function generateBatchImage({ prompt, material, baseImage, size, quality, style, sequence }) {
  if (demoImageMode) {
    return {
      imageDataUrl: buildBatchDemoImageDataUrl(material.safeName, baseImage.safeName, styleLabels[style], sequence, prompt.length),
      providerId: '',
      providerStatus: 0,
      providerAttempts: [],
    };
  }

  const enhancedPrompt = [
    `用户提示词：${prompt}`,
    `请结合素材图“${material.safeName}”与底板图“${baseImage.safeName}”生成结果。`,
    `画面风格：${styleLabels[style]}`,
    '保持素材主体可辨识，参考底板图构图、背景和氛围。',
    '请生成清晰、有细节、适合作为课程展示的高质量图片。',
  ].join('\n');

  const formData = new FormData();
  formData.append('model', 'gpt-image-1');
  formData.append('prompt', enhancedPrompt);
  formData.append('size', size);
  formData.append('quality', quality);
  formData.append('n', '1');
  formData.append('image[]', new Blob([baseImage.buffer], { type: baseImage.mime }), `${baseImage.safeName}${extensionForMime(baseImage.mime)}`);
  formData.append('image[]', new Blob([material.buffer], { type: material.mime }), `${material.safeName}${extensionForMime(material.mime)}`);

  const providerResult = await openAiProviderRouter.request('/images/edits', {
    method: 'POST',
    headers: {},
    body: formData,
  });

  const data = await providerResult.response.json().catch(() => ({}));

  const imageBase64 = data?.data?.[0]?.b64_json;
  if (!imageBase64) {
    const error = new Error('empty_image');
    error.code = 'empty_image';
    error.providerId = providerResult.providerId;
    error.providerStatus = providerResult.providerStatus;
    error.providerAttempts = providerResult.attempts;
    throw error;
  }

  return {
    imageDataUrl: `data:image/png;base64,${imageBase64}`,
    providerId: providerResult.providerId,
    providerStatus: providerResult.providerStatus,
    providerAttempts: providerResult.attempts,
  };
}

async function saveGeneratedImage({ imageDataUrl, materialName, baseName, sequence, outputDir, relativeDir, usedFileNames }) {
  const { mime, buffer } = dataUrlToFileParts(imageDataUrl);
  const extension = extensionForMime(mime) || '.png';
  const preferredName = `${materialName}_${baseName}_${String(sequence).padStart(2, '0')}${extension}`;
  const fileName = uniqueFileName(preferredName, usedFileNames);
  const absolutePath = path.join(outputDir, fileName);
  await writeFile(absolutePath, buffer);
  return {
    relativePath: path.join(relativeDir, fileName).replace(/\\/g, '/'),
  };
}

function dataUrlToFileParts(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) {
    const error = new Error('invalid_image_data');
    error.code = 'invalid_image_data';
    throw error;
  }
  return {
    mime: match[1].toLowerCase(),
    buffer: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
  };
}

function uniqueFileName(preferredName, usedFileNames) {
  const parsed = path.parse(preferredName);
  let candidate = preferredName;
  let counter = 2;
  while (usedFileNames.has(candidate)) {
    candidate = `${parsed.name}-${counter}${parsed.ext}`;
    counter += 1;
  }
  usedFileNames.add(candidate);
  return candidate;
}

function extensionForMime(mime) {
  const extensions = {
    'image/svg+xml': '.svg',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
  };
  return extensions[mime] || '.png';
}

function normalizeErrorType(error) {
  return error?.code || error?.message || 'unknown_error';
}

function publicBatchErrorMessage(errorType) {
  const messages = {
    missing_api_key: '服务端未配置 OPENAI_API_KEY，可开启 DEMO_IMAGE_MODE=true 演示流程。',
    provider_network_error: '图片生成服务连接中断。为避免重复生成，本次未自动切换服务端配置，请稍后再试。',
    provider_request_limit: '当前图片生成服务已达到本次运行的请求上限，请稍后再试。',
    provider_unavailable: '当前没有可用的图片生成服务，请稍后再试。',
    provider_retryable_error: '图片生成服务暂时不可用，本次已跳过并继续下一张。',
    provider_error: '图片生成服务返回错误，本次已跳过并继续下一张。',
    empty_image: '图片生成服务没有返回图片，本次已跳过并继续下一张。',
    invalid_image_data: '生成图片数据格式不正确，本次已跳过并继续下一张。',
  };
  return messages[errorType] || '本次生成失败，已记录错误并继续下一张。';
}

function publicImageErrorMessage(error) {
  const errorType = normalizeErrorType(error);
  const messages = {
    missing_api_key: '请先在服务端配置 OPENAI_API_KEY，或设置 DEMO_IMAGE_MODE=true 只演示流程。',
    provider_network_error: '图片生成服务连接中断。为避免重复生成，本次未自动切换服务端配置，请稍后再试。',
    provider_request_limit: '当前图片生成服务已达到本次运行的请求上限，请稍后再试。',
    provider_unavailable: '当前没有可用的图片生成服务，请稍后再试。',
    provider_retryable_error: '图片生成服务暂时不可用，请稍后再试。',
    provider_error: '图片生成服务返回错误，请检查服务端配置与请求参数后再试。',
    empty_image: '图片生成服务没有返回可用结果，请稍后再试。',
  };
  return messages[errorType] || '图片生成服务暂时不可用，请稍后再试。';
}

async function serveStatic(pathname, res) {
  const safePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const publicRoot = path.resolve(publicDir);
  const filePath = path.resolve(publicRoot, safePath);

  if (!filePath.startsWith(`${publicRoot}${path.sep}`) || !existsSync(filePath)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const content = await readFile(filePath);
  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  res.end(content);
}

function getSession(req) {
  const sessionId = getCookie(req, 'gpt_auto_session');
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies
    .split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(`${name}=`));

  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function buildSessionCookie(sessionId) {
  const maxAgeSeconds = Math.floor(sessionMaxAgeMs / 1000);
  return `gpt_auto_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function isInternalAccessConfigured() {
  return Boolean(internalAccessCode && !internalAccessCode.includes('replace-with-internal-access-code'));
}

async function recordRuntimeEvent(event) {
  const safeEvent = {
    id: randomUUID(),
    at: new Date().toISOString(),
    eventType: event.eventType || 'image_generation',
    batchId: event.batchId || '',
    fleetId: event.fleetId || '',
    fleetName: event.fleetName || '',
    materialName: event.materialName || '',
    baseName: event.baseName || '',
    outputPath: event.outputPath || '',
    size: event.size || '',
    quality: event.quality || '',
    style: event.style || '',
    promptLength: Number(event.promptLength || 0),
    result: event.result || 'error',
    errorType: event.errorType || '',
    mode: event.mode || '',
    providerId: event.providerId || '',
    providerStatus: Number(event.providerStatus || 0),
    providerFailoverCount: Number(event.providerFailoverCount || 0),
  };

  try {
    await mkdir(dataDir, { recursive: true });
    await appendFile(runtimeEventsFile, `${JSON.stringify(safeEvent)}\n`, 'utf8');
    console.info('[runtime]', JSON.stringify(safeEvent));
  } catch (error) {
    console.error('运行状态记录失败：', error.message);
  }
}

function readRequestBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let receivedBytes = 0;
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      reject(error);
      req.destroy();
    }

    req.on('data', chunk => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        const error = new Error('Request body too large');
        error.statusCode = 413;
        fail(error);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(body);
    });
    req.on('error', fail);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function writeNdjson(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function readEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!existsSync(envPath)) return {};

  try {
    return Object.fromEntries(
      readFileSync(envPath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && line.includes('='))
        .map(line => {
          const index = line.indexOf('=');
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

function buildDemoImageDataUrl(prompt, fleetName, styleLabel) {
  const title = escapeSvg(fleetName);
  const subtitle = escapeSvg(styleLabel);
  const promptPreview = escapeSvg(prompt.slice(0, 46));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#7c5cff"/>
          <stop offset="52%" stop-color="#14213d"/>
          <stop offset="100%" stop-color="#2ee59d"/>
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" fill="url(#bg)"/>
      <circle cx="790" cy="220" r="126" fill="rgba(255,255,255,0.16)"/>
      <circle cx="238" cy="762" r="168" fill="rgba(255,255,255,0.12)"/>
      <rect x="116" y="318" width="792" height="388" rx="54" fill="rgba(9,13,26,0.72)" stroke="rgba(255,255,255,0.35)" stroke-width="3"/>
      <text x="512" y="426" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="58" font-weight="700">GPT 图片生成 Demo</text>
      <text x="512" y="510" text-anchor="middle" fill="#dce4ff" font-family="Arial, sans-serif" font-size="36">${title} · ${subtitle}</text>
      <text x="512" y="594" text-anchor="middle" fill="#9aa8c7" font-family="Arial, sans-serif" font-size="28">${promptPreview}</text>
      <text x="512" y="646" text-anchor="middle" fill="#9aa8c7" font-family="Arial, sans-serif" font-size="24">演示模式未使用真实 API Key</text>
    </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function buildBatchDemoImageDataUrl(materialName, baseName, styleLabel, sequence, promptLength) {
  const material = escapeSvg(materialName);
  const base = escapeSvg(baseName);
  const subtitle = escapeSvg(styleLabel);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs>
        <linearGradient id="batch-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1b2a6b"/>
          <stop offset="48%" stop-color="#7c5cff"/>
          <stop offset="100%" stop-color="#2ee59d"/>
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" fill="url(#batch-bg)"/>
      <rect x="90" y="126" width="844" height="772" rx="64" fill="rgba(9,13,26,0.72)" stroke="rgba(255,255,255,0.36)" stroke-width="3"/>
      <text x="512" y="256" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="58" font-weight="700">批量素材生成 Demo</text>
      <text x="512" y="362" text-anchor="middle" fill="#dce4ff" font-family="Arial, sans-serif" font-size="34">素材：${material}</text>
      <text x="512" y="432" text-anchor="middle" fill="#dce4ff" font-family="Arial, sans-serif" font-size="34">底板：${base}</text>
      <text x="512" y="502" text-anchor="middle" fill="#dce4ff" font-family="Arial, sans-serif" font-size="34">风格：${subtitle} · 序号 ${sequence}</text>
      <text x="512" y="616" text-anchor="middle" fill="#9aa8c7" font-family="Arial, sans-serif" font-size="26">提示词长度：${promptLength} 字；未保存完整提示词</text>
      <text x="512" y="672" text-anchor="middle" fill="#9aa8c7" font-family="Arial, sans-serif" font-size="24">演示模式未调用外部接口，不使用真实 API Key</text>
    </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function sanitizeFileStem(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\.[^.\\/]+$/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function escapeSvg(text) {
  return String(text).replace(/[&<>'"]/g, char => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
    return map[char];
  });
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function throwHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}
