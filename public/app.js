const fleets = [
  {
    id: 'aurora',
    name: '极光车队',
    icon: '🌌',
    desc: '适合创意插画、人物头像和生活场景。',
    tags: ['创意', '头像', '插画'],
    quota: '剩余 18 次',
  },
  {
    id: 'nebula',
    name: '星云车队',
    icon: '🚀',
    desc: '适合科幻海报、产品概念和电影画面。',
    tags: ['科幻', '海报', '产品'],
    quota: '剩余 12 次',
  },
  {
    id: 'pixel',
    name: '像素车队',
    icon: '🎨',
    desc: '适合表情包、贴纸、卡通和像素风设计。',
    tags: ['贴纸', '卡通', '像素'],
    quota: '剩余 25 次',
  },
];

const defaultRuntimeState = {
  fleetId: '',
  fleetName: '未选择',
  status: '等待选择车队',
  lastAction: '尚未生成',
  lastError: '无',
  outputPath: '未生成',
  result: 'idle',
};

const batchDefaults = {
  maxMaterials: 10,
  maxOutputs: 30,
  maxPerMaterial: 4,
  maxFileBytes: 8 * 1024 * 1024,
};

const loginPage = document.querySelector('#loginPage');
const fleetPage = document.querySelector('#fleetPage');
const chatPage = document.querySelector('#chatPage');
const fleetList = document.querySelector('#fleetList');
const loginForm = document.querySelector('#loginForm');
const accessCodeInput = document.querySelector('#accessCodeInput');
const loginButton = document.querySelector('#loginButton');
const loginError = document.querySelector('#loginError');
const logoutButton = document.querySelector('#logoutButton');
const backButton = document.querySelector('#backButton');
const promptForm = document.querySelector('#promptForm');
const promptInput = document.querySelector('#promptInput');
const messages = document.querySelector('#messages');
const generateButton = document.querySelector('#generateButton');
const sizeSelect = document.querySelector('#sizeSelect');
const qualitySelect = document.querySelector('#qualitySelect');
const styleSelect = document.querySelector('#styleSelect');
const runtimeBadge = document.querySelector('#runtimeBadge');
const runtimeFleet = document.querySelector('#runtimeFleet');
const runtimeStatus = document.querySelector('#runtimeStatus');
const runtimeLastAction = document.querySelector('#runtimeLastAction');
const runtimeError = document.querySelector('#runtimeError');
const runtimeOutput = document.querySelector('#runtimeOutput');
const singleModeTab = document.querySelector('#singleModeTab');
const batchModeTab = document.querySelector('#batchModeTab');
const singlePanel = document.querySelector('#singlePanel');
const batchPanel = document.querySelector('#batchPanel');
const batchForm = document.querySelector('#batchForm');
const materialsInput = document.querySelector('#materialsInput');
const baseFolderInput = document.querySelector('#baseFolderInput');
const promptFileInput = document.querySelector('#promptFileInput');
const baseImageSelect = document.querySelector('#baseImageSelect');
const outputLabelInput = document.querySelector('#outputLabelInput');
const batchQualitySelect = document.querySelector('#batchQualitySelect');
const batchStyleSelect = document.querySelector('#batchStyleSelect');
const previewBatchButton = document.querySelector('#previewBatchButton');
const startBatchButton = document.querySelector('#startBatchButton');
const batchNote = document.querySelector('#batchNote');
const batchPlanSummary = document.querySelector('#batchPlanSummary');
const batchProgress = document.querySelector('#batchProgress');
const batchTotal = document.querySelector('#batchTotal');
const batchCurrent = document.querySelector('#batchCurrent');
const batchSuccess = document.querySelector('#batchSuccess');
const batchFailed = document.querySelector('#batchFailed');
const batchOutputDir = document.querySelector('#batchOutputDir');
const batchLog = document.querySelector('#batchLog');

let selectedFleet = null;
let runtimeState = loadRuntimeState();
let promptFileText = '';
let baseImageFiles = [];
let lastBatchPlan = null;
let isBatchRunning = false;

renderFleets();
updateRuntimeStatus(runtimeState, { persist: false });
bootstrapSession();

loginForm.addEventListener('submit', async event => {
  event.preventDefault();

  const accessCode = accessCodeInput.value.trim();
  if (!accessCode) {
    loginError.textContent = '请输入内部访问码。';
    return;
  }

  loginButton.disabled = true;
  loginButton.textContent = '验证中…';
  loginError.textContent = '';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode }),
    });
    const data = await response.json();

    if (!response.ok) {
      loginError.textContent = data.error || '内部访问验证失败。';
      return;
    }

    accessCodeInput.value = '';
    showFleetPage();
  } catch {
    loginError.textContent = '验证请求失败，请确认后端服务正在运行。';
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = '进入车队池';
  }
});

logoutButton.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  selectedFleet = null;
  chatPage.classList.add('hidden');
  fleetPage.classList.add('hidden');
  loginPage.classList.remove('hidden');
  accessCodeInput.focus();
});

backButton.addEventListener('click', () => {
  chatPage.classList.add('hidden');
  fleetPage.classList.remove('hidden');
});

singleModeTab.addEventListener('click', () => switchMode('single'));
batchModeTab.addEventListener('click', () => switchMode('batch'));

baseFolderInput.addEventListener('change', () => {
  baseImageFiles = sortFiles([...baseFolderInput.files]).filter(isImageFile);
  renderBaseImageOptions();
  updateBatchPreviewFromInputs();
});

materialsInput.addEventListener('change', updateBatchPreviewFromInputs);

promptFileInput.addEventListener('change', async () => {
  promptFileText = '';
  const file = promptFileInput.files[0];
  if (!file) {
    updateBatchPreviewFromInputs();
    return;
  }

  if (!file.name.toLowerCase().endsWith('.txt') && file.type !== 'text/plain') {
    batchNote.textContent = '提示词文件需要是 txt 文本文件。';
    updateBatchPreviewFromInputs();
    return;
  }

  promptFileText = (await file.text()).trim();
  updateBatchPreviewFromInputs();
});

baseImageSelect.addEventListener('change', updateBatchPreviewFromInputs);
previewBatchButton.addEventListener('click', updateBatchPreviewFromInputs);

promptForm.addEventListener('submit', async event => {
  event.preventDefault();

  const prompt = promptInput.value.trim();
  if (!prompt) return;

  if (!selectedFleet) {
    appendMessage('bot', '请先返回首页选择一个车队。', true);
    updateRuntimeStatus({ status: '缺少车队选择', lastError: '未选择车队', result: 'error' });
    return;
  }

  appendMessage('user', prompt);
  promptInput.value = '';
  setLoading(true);
  updateRuntimeStatus({
    fleetId: selectedFleet.id,
    fleetName: selectedFleet.name,
    status: '生成中',
    lastAction: `${formatTime()} · 提示词 ${prompt.length} 字`,
    lastError: '无',
    outputPath: '单张生成返回浏览器预览',
    result: 'loading',
  });

  const loadingMessage = appendMessage('bot', '图片正在生成中，请稍等……');

  try {
    const response = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        fleetId: selectedFleet.id,
        size: sizeSelect.value,
        quality: qualitySelect.value,
        style: styleSelect.value,
      }),
    });

    const data = await response.json();
    loadingMessage.remove();

    if (response.status === 401) {
      appendMessage('bot', '内部访问已失效，请重新验证。', true);
      showLoginPage();
      return;
    }

    if (!response.ok) {
      const errorText = data.error || '图片生成失败，请稍后重试。';
      appendMessage('bot', errorText, true);
      updateRuntimeStatus({
        status: '生成失败',
        lastAction: `${formatTime()} · 提示词 ${prompt.length} 字`,
        lastError: errorText,
        result: 'error',
      });
      return;
    }

    appendImageMessage(data.imageUrl, prompt, data.fleet || selectedFleet.name);
    updateRuntimeStatus({
      status: '生成成功',
      lastAction: `${formatTime()} · 提示词 ${prompt.length} 字`,
      lastError: '无',
      outputPath: '单张生成返回浏览器预览',
      result: 'success',
    });
  } catch {
    loadingMessage.remove();
    const errorText = '网络请求失败，请确认后端服务正在运行。';
    appendMessage('bot', errorText, true);
    updateRuntimeStatus({
      status: '请求失败',
      lastAction: `${formatTime()} · 提示词 ${prompt.length} 字`,
      lastError: errorText,
      result: 'error',
    });
  } finally {
    setLoading(false);
  }
});

batchForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (isBatchRunning) return;

  const plan = updateBatchPreviewFromInputs();
  if (!plan.ready) {
    appendBatchLog(plan.message, 'error');
    return;
  }

  const confirmed = window.confirm(
    `本次将处理 ${plan.materialCount} 张素材，每张生成 ${plan.perMaterialCount} 张，共 ${plan.totalOutputs} 张。结果保存到后端 outputs/日期时间/ 目录。确认开始？`
  );
  if (!confirmed) return;

  isBatchRunning = true;
  setBatchRunning(true);
  clearBatchLog();
  updateBatchProgress({ total: plan.totalOutputs, current: 0, success: 0, failed: 0, outputDir: '创建中…' });
  updateRuntimeStatus({
    fleetId: selectedFleet?.id || '',
    fleetName: selectedFleet?.name || '未选择',
    status: '批量生成中',
    lastAction: `${formatTime()} · 计划 ${plan.totalOutputs} 张`,
    lastError: '无',
    outputPath: 'outputs/日期时间/',
    result: 'loading',
  });

  try {
    const payload = await buildBatchPayload();
    const response = await fetch('/api/batch-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.status === 401) {
      appendBatchLog('内部访问已失效，请重新验证。', 'error');
      showLoginPage();
      return;
    }

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '批量生成请求失败。');
    }

    await consumeBatchStream(response.body, plan.totalOutputs);
  } catch (error) {
    const errorText = error.message || '批量生成失败。';
    appendBatchLog(errorText, 'error');
    updateRuntimeStatus({ status: '批量失败', lastError: errorText, result: 'error' });
  } finally {
    isBatchRunning = false;
    setBatchRunning(false);
  }
});

async function bootstrapSession() {
  try {
    const response = await fetch('/api/session');
    const data = await response.json();
    if (data.authenticated) {
      showFleetPage();
      return;
    }
  } catch {
    loginError.textContent = '暂时无法连接后端服务。';
  }

  showLoginPage();
}

function showLoginPage() {
  chatPage.classList.add('hidden');
  fleetPage.classList.add('hidden');
  loginPage.classList.remove('hidden');
}

function showFleetPage() {
  loginPage.classList.add('hidden');
  chatPage.classList.add('hidden');
  fleetPage.classList.remove('hidden');
}

function renderFleets() {
  fleetList.innerHTML = fleets
    .map(
      fleet => `
        <button class="fleet-card" data-fleet-id="${fleet.id}">
          <span class="fleet-icon">${fleet.icon}</span>
          <span class="fleet-content">
            <strong>${fleet.name}</strong>
            <small>${fleet.desc}</small>
            <span class="tag-row">${fleet.tags.map(tag => `<em>${tag}</em>`).join('')}</span>
          </span>
          <span class="quota">${fleet.quota}</span>
        </button>
      `
    )
    .join('');

  document.querySelectorAll('.fleet-card').forEach(card => {
    card.addEventListener('click', () => enterFleet(card.dataset.fleetId));
  });
}

function enterFleet(fleetId) {
  selectedFleet = fleets.find(fleet => fleet.id === fleetId) || fleets[0];
  document.querySelector('#selectedFleetIcon').textContent = selectedFleet.icon;
  document.querySelector('#selectedFleetName').textContent = selectedFleet.name;
  document.querySelector('#selectedFleetDesc').textContent = selectedFleet.desc;

  updateRuntimeStatus({
    fleetId: selectedFleet.id,
    fleetName: selectedFleet.name,
    status: '已选择车队',
    lastAction: `${formatTime()} · 进入工作台`,
    lastError: '无',
    result: 'idle',
  });

  resetMessages(selectedFleet);
  fleetPage.classList.add('hidden');
  chatPage.classList.remove('hidden');
  promptInput.focus();
}

function resetMessages(fleet) {
  messages.innerHTML = '';
  appendMessage('bot', `你好！已进入 ${fleet.name}。选择图片尺寸和风格后，输入你想生成的画面，我会帮你生成图片。`);
}

function switchMode(mode) {
  const isBatch = mode === 'batch';
  batchModeTab.classList.toggle('active', isBatch);
  singleModeTab.classList.toggle('active', !isBatch);
  batchPanel.classList.toggle('hidden', !isBatch);
  singlePanel.classList.toggle('hidden', isBatch);
  updateRuntimeStatus({
    status: isBatch ? '批量模式待命' : '单张模式待命',
    lastAction: `${formatTime()} · 切换到${isBatch ? '批量素材生成' : '单张聊天生成'}`,
    lastError: '无',
    result: 'idle',
  });
}

function appendMessage(type, text, isError = false) {
  const message = document.createElement('article');
  message.className = `message ${type}${isError ? ' error' : ''}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = type === 'user' ? '我' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  message.append(avatar, bubble);
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;
  return message;
}

function appendImageMessage(imageUrl, prompt, fleet) {
  const message = document.createElement('article');
  message.className = 'message bot';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'bubble image-bubble';

  const text = document.createElement('p');
  text.textContent = `已通过 ${fleet} 生成图片：`;

  const image = document.createElement('img');
  image.src = imageUrl;
  image.alt = prompt;

  const link = document.createElement('a');
  link.className = 'download-link';
  link.href = imageUrl;
  link.download = 'gpt-generated-image.png';
  link.textContent = '下载图片';

  bubble.append(text, image, link);
  message.append(avatar, bubble);
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;
}

function updateRuntimeStatus(nextState, options = {}) {
  runtimeState = { ...runtimeState, ...nextState };
  runtimeFleet.textContent = runtimeState.fleetName;
  runtimeStatus.textContent = runtimeState.status;
  runtimeLastAction.textContent = runtimeState.lastAction;
  runtimeError.textContent = runtimeState.lastError;
  runtimeOutput.textContent = runtimeState.outputPath;
  runtimeError.classList.toggle('is-error', runtimeState.lastError !== '无');
  runtimeBadge.textContent = runtimeState.status;
  runtimeBadge.className = `status-dot ${runtimeState.result}`;

  if (options.persist !== false) {
    saveRuntimeState(runtimeState);
  }
}

function loadRuntimeState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('gptAutoRuntimeState') || 'null');
    if (!saved || typeof saved !== 'object') return { ...defaultRuntimeState };
    return { ...defaultRuntimeState, ...saved };
  } catch {
    return { ...defaultRuntimeState };
  }
}

function saveRuntimeState(state) {
  const safeState = {
    fleetId: state.fleetId,
    fleetName: state.fleetName,
    status: state.status,
    lastAction: state.lastAction,
    lastError: state.lastError,
    outputPath: state.outputPath,
    result: state.result,
  };
  sessionStorage.setItem('gptAutoRuntimeState', JSON.stringify(safeState));
}

function setLoading(isLoading) {
  generateButton.disabled = isLoading;
  generateButton.textContent = isLoading ? '生成中…' : '生成图片';
}

function renderBaseImageOptions() {
  if (!baseImageFiles.length) {
    baseImageSelect.innerHTML = '<option value="">请先选择底板图文件夹</option>';
    return;
  }

  baseImageSelect.innerHTML = baseImageFiles
    .map((file, index) => `<option value="${index}">${file.webkitRelativePath || file.name}</option>`)
    .join('');
}

function updateBatchPreviewFromInputs() {
  const materialFiles = sortFiles([...materialsInput.files]).filter(isImageFile);
  const selectedBase = getSelectedBaseImage();
  const countPlan = parseGenerationCount(promptFileText);
  const totalOutputs = materialFiles.length * countPlan.perMaterialCount;
  const problems = [];

  if (!materialFiles.length) problems.push('请选择素材图文件夹');
  if (!selectedBase) problems.push('请选择底板图');
  if (promptFileText.length < 3) problems.push('请选择有效提示词 txt');
  if (materialFiles.length > batchDefaults.maxMaterials) problems.push(`素材图超过 ${batchDefaults.maxMaterials} 张上限`);
  if (totalOutputs > batchDefaults.maxOutputs) problems.push(`计划输出 ${totalOutputs} 张，超过 ${batchDefaults.maxOutputs} 张上限`);

  const ready = problems.length === 0;

  lastBatchPlan = {
    ready,
    materialCount: materialFiles.length,
    perMaterialCount: countPlan.perMaterialCount,
    totalOutputs,
    warning: countPlan.warning,
    message: problems.join('；') || '可以开始批量生成',
  };

  batchPlanSummary.textContent = ready
    ? `计划 ${materialFiles.length} 张素材 × 每张 ${countPlan.perMaterialCount} 张 = ${totalOutputs} 张`
    : lastBatchPlan.message;
  batchTotal.textContent = String(totalOutputs || 0);
  batchNote.textContent = countPlan.warning || '浏览器不能稳定授权网页任意写入本地文件夹，第一版使用后端 outputs/日期时间/ 目录保存结果。';
  startBatchButton.disabled = !ready || isBatchRunning;
  return lastBatchPlan;
}

async function buildBatchPayload() {
  const materialFiles = sortFiles([...materialsInput.files]).filter(isImageFile).slice(0, batchDefaults.maxMaterials);
  const selectedBase = getSelectedBaseImage();
  if (!selectedBase) throw new Error('请先选择本次使用的底板图。');

  return {
    fleetId: selectedFleet?.id || '',
    promptText: promptFileText,
    baseImage: await fileToPayload(selectedBase),
    materials: await Promise.all(materialFiles.map(fileToPayload)),
    outputLabel: outputLabelInput.value.trim(),
    size: sizeSelect.value,
    quality: batchQualitySelect.value,
    style: batchStyleSelect.value,
  };
}

async function consumeBatchStream(stream, plannedOutputs) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let current = 0;
  let success = 0;
  let failed = 0;
  let outputDir = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);

      if (event.type === 'plan') {
        outputDir = event.outputDir;
        updateBatchProgress({ total: event.plannedOutputs, current, success, failed, outputDir });
        if (event.warning) appendBatchLog(event.warning, 'warning');
        appendBatchLog(`开始批量生成：${event.totalMaterials} 张素材，每张 ${event.perMaterialCount} 张，输出到 ${event.outputDir}`);
      }

      if (event.type === 'progress') {
        current += 1;
        if (event.status === 'success') {
          success += 1;
          appendBatchLog(`成功：${event.materialName} + ${event.baseName} #${event.sequence} → ${event.outputPath}`);
        } else {
          failed += 1;
          appendBatchLog(`失败：${event.materialName} #${event.sequence}，${event.error}`, 'error');
        }
        updateBatchProgress({ total: plannedOutputs, current, success, failed, outputDir });
      }

      if (event.type === 'complete') {
        outputDir = event.outputDir;
        updateBatchProgress({ total: event.plannedOutputs, current: event.success + event.failed, success: event.success, failed: event.failed, outputDir });
        appendBatchLog(`完成：成功 ${event.success}，失败 ${event.failed}，输出目录 ${event.outputDir}`);
        updateRuntimeStatus({
          status: event.failed ? '批量完成（有失败）' : '批量完成',
          lastAction: `${formatTime()} · 成功 ${event.success} / 失败 ${event.failed}`,
          lastError: event.failed ? `${event.failed} 次失败，详见批量日志` : '无',
          outputPath: event.outputDir,
          result: event.failed ? 'error' : 'success',
        });
      }
    }
  }
}

function updateBatchProgress({ total, current, success, failed, outputDir }) {
  batchProgress.max = Math.max(total || 1, 1);
  batchProgress.value = Math.min(current || 0, batchProgress.max);
  batchTotal.textContent = String(total || 0);
  batchCurrent.textContent = total ? `${Math.min(current || 0, total)} / ${total}` : '未开始';
  batchSuccess.textContent = String(success || 0);
  batchFailed.textContent = String(failed || 0);
  batchOutputDir.textContent = outputDir || '未生成';
}

function appendBatchLog(text, level = 'info') {
  const item = document.createElement('p');
  item.className = `batch-log-item ${level}`;
  item.textContent = text;
  batchLog.appendChild(item);
  batchLog.scrollTop = batchLog.scrollHeight;
}

function clearBatchLog() {
  batchLog.innerHTML = '';
}

function setBatchRunning(running) {
  previewBatchButton.disabled = running;
  startBatchButton.disabled = running;
  startBatchButton.textContent = running ? '批量生成中…' : '开始批量生成';
}

function getSelectedBaseImage() {
  const index = Number(baseImageSelect.value);
  return Number.isInteger(index) ? baseImageFiles[index] : null;
}

function parseGenerationCount(promptText) {
  const text = String(promptText || '');
  const patterns = [
    /每(?:张|个)?(?:素材|图片|图)?(?:生成|出图|输出)?\s*(\d{1,2}|[一二两三四五六七八九十])\s*张/u,
    /(?:生成数量|输出数量|出图数量|张数|数量)\s*[:：=]?\s*(\d{1,2}|[一二两三四五六七八九十])\s*张?/u,
    /(?:n|count)\s*[:：=]\s*(\d{1,2})/iu,
    /(\d{1,2}|[一二两三四五六七八九十])\s*张(?:图|图片|结果)?/u,
  ];

  let count = 0;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    count = parseCountToken(match[1]);
    if (count > 0) break;
  }

  if (!count) {
    return {
      perMaterialCount: 1,
      warning: '未能从提示词可靠解析生成数量，已按每张素材 1 张处理。',
    };
  }

  if (count > batchDefaults.maxPerMaterial) {
    return {
      perMaterialCount: batchDefaults.maxPerMaterial,
      warning: `提示词要求每张 ${count} 张，已按安全上限限制为每张 ${batchDefaults.maxPerMaterial} 张。`,
    };
  }

  return { perMaterialCount: count, warning: '' };
}

function parseCountToken(token) {
  const normalized = String(token || '').trim();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  const chineseNumbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return chineseNumbers[normalized] || 0;
}

async function fileToPayload(file) {
  if (file.size > batchDefaults.maxFileBytes) {
    throw new Error(`${file.name} 超过 8MB 上限。`);
  }

  return {
    name: file.name,
    dataUrl: await readFileAsDataUrl(file),
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`${file.name} 读取失败。`));
    reader.readAsDataURL(file);
  });
}

function isImageFile(file) {
  return ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
}

function sortFiles(files) {
  return files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'zh-CN'));
}

function formatTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
