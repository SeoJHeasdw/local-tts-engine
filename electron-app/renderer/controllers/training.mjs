import { trainingClipAssessment, recommendedTrainingReference } from '../../shared/training-review.mjs';

export function createTrainingController({ $, api, start, showError, document: doc = document }) {
  let dataset = null, request = 0, recommendedId = null, loading = false;
  // Preserve each speaker's in-memory edits, never listening checks on changed audio.
  const drafts = new Map();
  const put = (selector, text) => { const node = $(selector); if (node) node.textContent = text; };

  function element(tag, className, content) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function selection() {
    const cards = [...$('#training-clips').children];
    return {
      reviews: cards.map(card => ({ id: card.dataset.clipId,
        text: card.querySelector('textarea').value, accepted: card.querySelector('[data-accept]').checked })),
      referenceId: cards.find(card => card.querySelector('[name="training-reference"]').checked)?.dataset.clipId || null,
    };
  }

  function rememberDraft() {
    if (!dataset || loading) return;
    const { reviews, referenceId } = selection();
    drafts.set(dataset.id, { reviews: reviews.map(review => ({ ...review,
      original: dataset.clips.find(clip => clip.id === review.id) })), referenceId,
      displayName: $('#training-profile-name').value, name: $('#finetune-name').value,
      maxSteps: $('#finetune-steps').value });
  }

  function sameAudio(one, two) {
    const firstHash = one?.audioSha256 || one?.quality?.audioSha256;
    const secondHash = two.audioSha256 || two.quality?.audioSha256;
    return one?.audioUrl === two.audioUrl && one?.durationMs === two.durationMs
      && (!firstHash || !secondHash || firstHash === secondHash);
  }

  function clearError() {
    $('#finetune-error').textContent = '';
    $('#finetune-error').classList.add('hidden');
  }

  function stepStatus(text, stage = 'prepare') {
    put('#training-step-status', text);
    const names = ['prepare', 'review', 'create'];
    for (const [index, name] of names.entries()) {
      const node = $(`#training-step-${name}`);
      if (node) node.dataset.state = name === stage ? 'current' : index < names.indexOf(stage) ? 'complete' : 'ready';
    }
  }

  function unavailable(message, hint, { busy = false, empty = false } = {}) {
    rememberDraft();
    dataset = null;
    recommendedId = null;
    loading = busy;
    for (const card of $('#training-clips').children) card.querySelector('audio').pause();
    $('#training-clips').replaceChildren();
    $('#training-clips').setAttribute('aria-busy', String(busy));
    $('#training-profile-name').value = '';
    $('#finetune-name').value = '';
    for (const selector of ['#training-profile-name', '#finetune-name', '#finetune-steps']) $(selector).disabled = true;
    put('#training-summary', message);
    put('#training-selection', '학습할 녹음이 아직 선택되지 않았습니다.');
    put('#training-selection-hint', hint);
    $('#training-recommendation').classList.add('hidden');
    put('#training-reference-hint', '');
    $('#prepare-training').disabled = true;
    $('#start-finetune').disabled = true;
    $('#start-finetune').title = hint;
    put('#training-prepare-hint', hint);
    if ($('#reload-training-datasets')) $('#reload-training-datasets').disabled = busy;
    $('#training-review-empty')?.classList.remove('hidden');
    put('#training-review-empty', busy ? '녹음을 불러오면 여기에서 듣고 글을 확인할 수 있습니다.'
      : empty ? '한 사람의 녹음 파일을 불러오면 목록에 나타납니다. 자동 분석 후 여기에서 듣고 확인할 수 있습니다.'
        : '녹음을 다시 불러오면 이어서 확인할 수 있습니다. 목소리 학습은 시작되지 않았습니다.');
    put('#training-start-label', '목소리 학습 시작');
    stepStatus(message);
  }

  function validation(mode = 'train', selected = selection()) {
    if (!dataset || loading || dataset.id !== $('#training-dataset').value) return '먼저 학습할 사람의 녹음을 선택해 주세요.';
    if (!dataset.legacy && !dataset.clips.length) return '이 묶음에는 학습할 녹음이 없습니다. 한 사람의 녹음 파일을 다시 불러와 주세요.';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test($('#finetune-name').value.trim())) {
      return '고급 설정의 결과 폴더 이름은 1~80자의 영문·숫자·밑줄·붙임표로 입력해 주세요.';
    }
    if (mode === 'prepare') return '';
    const displayName = $('#training-profile-name').value.trim();
    if (!displayName || displayName.length > 80) return '목소리 이름을 1~80자로 입력해 주세요. 이 이름이 목소리 목록에 표시됩니다.';
    const maxSteps = Number($('#finetune-steps').value);
    if (!Number.isInteger(maxSteps) || maxSteps < 10 || maxSteps > 500) return '고급 설정의 학습 횟수는 10~500 사이의 정수로 입력해 주세요.';
    if (dataset.legacy) return '';
    const included = selected.reviews.filter(item => item.accepted);
    if (included.length < 3) return `듣고 글이 맞는지 확인한 녹음을 최소 3개 포함해 주세요. 지금은 ${included.length}개입니다.`;
    if (selected.reviews.some(item => item.text.length > 2000)) return '녹음의 글은 한 녹음당 2,000자 이내로 입력해 주세요.';
    if (included.some(item => !item.text.trim())) return '학습에 포함한 녹음에 글이 비어 있습니다. 들리는 말을 적고 다시 확인해 주세요.';
    if (!included.some(item => item.id === selected.referenceId)) return '학습에 포함한 녹음 중 평소 말투가 또렷한 하나를 대표 녹음으로 선택해 주세요.';
    return '';
  }

  function paintSelection() {
    if (!dataset) return;
    for (const card of $('#training-clips').children) {
      const accepted = card.querySelector('[data-accept]').checked;
      const reference = card.querySelector('[name="training-reference"]');
      reference.disabled = !accepted || !card.querySelector('textarea').value.trim();
      if (reference.disabled) reference.checked = false;
      card.classList.toggle('is-training', accepted);
      card.classList.toggle('is-reference', reference.checked);
      card.querySelector('[data-reference-hint]').textContent = reference.disabled
        ? '먼저 듣고 글을 확인한 뒤 ‘학습에 포함’을 체크하면 선택할 수 있습니다.'
        : '새 문장을 읽을 때 음색과 말투의 기준으로 사용할 녹음입니다.';
    }
    const selected = selection();
    const included = selected.reviews.filter(item => item.accepted);
    const includedIds = new Set(included.map(item => item.id));
    const duration = dataset.clips.filter(clip => includedIds.has(clip.id)).reduce((sum, clip) => sum + clip.durationMs, 0);
    const referenceNumber = dataset.clips.findIndex(clip => clip.id === selected.referenceId) + 1;
    const reason = validation('train', selected);
    put('#training-selection', dataset.legacy ? `${dataset.displayName}의 확인을 마친 녹음을 사용합니다.`
      : `학습에 포함: ${included.length}개 · ${(duration / 1000).toFixed(0)}초 / 대표 녹음: ${referenceNumber ? `녹음 ${referenceNumber}` : '아직 선택 안 함'}`);
    $('#start-finetune').disabled = Boolean(reason);
    $('#start-finetune').title = reason || '확인한 녹음으로 새 목소리를 만듭니다.';
    put('#training-selection-hint', `${reason || '준비됐습니다. 학습이 끝나면 새 문장을 읽는 샘플을 듣고 목소리 사용을 결정하세요.'} 이 화면의 글 수정과 선택은 학습 시작 때 반영됩니다.`);
    put('#training-start-label', dataset.legacy ? '확인된 녹음으로 학습 시작' : `확인한 녹음 ${included.length}개로 학습 시작`);
    const analysed = dataset.legacy || (dataset.total > 0 && dataset.transcribed === dataset.total && dataset.qualityReviewed === dataset.total);
    const prepareReason = validation('prepare', selected);
    $('#prepare-training').disabled = dataset.legacy || analysed || Boolean(prepareReason);
    put('#training-prepare-hint', dataset.legacy ? '이미 확인한 녹음이므로 자동 분석을 다시 할 필요가 없습니다.'
      : prepareReason || (analysed ? '자동 분석이 끝났습니다. 다음 단계에서 직접 듣고 확인해 주세요.'
        : '녹음의 글을 자동으로 채우고 잡음·잘린 말·받아쓰기 차이를 확인합니다. 분석 결과는 직접 듣고 확인해야 합니다.'));
    $('#training-review-empty')?.classList.toggle('hidden', dataset.legacy || dataset.clips.length > 0);
    if (!dataset.legacy && !dataset.clips.length) put('#training-review-empty', '이 묶음에는 확인할 녹음이 없습니다. 한 사람의 녹음 파일을 다시 불러와 주세요.');
    const reviewReady = dataset.legacy || (included.length >= 3 && included.every(item => item.text.trim())
      && included.some(item => item.id === selected.referenceId));
    const stage = reviewReady ? 'create' : analysed || included.length ? 'review' : 'prepare';
    stepStatus(stage === 'create' ? reason ? `3단계 · ${reason}` : '3단계 · 목소리 학습을 시작할 수 있습니다. 완료 후 샘플을 들어 주세요.'
      : stage === 'review' ? '2단계 · 녹음을 듣고 글과 학습 포함 여부를 확인해 주세요.'
        : '1단계 · 녹음의 글과 녹음 상태를 자동으로 준비해 주세요.', stage);
  }

  function paintAssessment(card, clip) {
    const a = trainingClipAssessment(clip, card.querySelector('textarea').value);
    const badges = card.querySelector('[data-assessment]');
    badges.replaceChildren(element('span', 'training-badge', a.trainingLabel), element('span', 'training-badge', a.referenceLabel));
    if (clip.id === recommendedId) badges.append(element('span', 'training-badge recommended', '대표 녹음으로 먼저 들어볼 후보'));
    const similarity = card.querySelector('[data-agreement]');
    similarity.textContent = `두 자동 받아쓰기의 일치도: ${clip.quality?.independentText === '' ? '비교할 글 없음' : a.agreement === null ? '아직 비교하지 않음' : `${Math.round(a.agreement * 100)}%`}`;
    similarity.classList.toggle('warning', a.agreement !== null && a.agreement < 0.9);
    const warnings = card.querySelector('[data-warnings]');
    warnings.replaceChildren(...a.warnings.map(item => element('li', '', item.message)));
    if (!a.warnings.length) warnings.append(element('li', 'no-warning', a.audio ? '자동 분석에서 경고는 없었습니다. 잡음·다른 사람의 말·잘린 말끝은 직접 들어 확인해 주세요.' : '아직 자동 분석 전입니다. 먼저 녹음의 글과 녹음 상태를 준비해 주세요.'));
  }

  function render(value) {
    rememberDraft();
    ++request;
    loading = false;
    dataset = value;
    const draft = drafts.get(value.id);
    if (![...$('#training-dataset').children].some(option => option.value === value.id)) {
      const option = element('option', '', `${value.displayName} · 녹음 ${value.total}개`);
      option.value = value.id;
      $('#training-dataset').append(option);
    }
    $('#training-dataset').value = value.id;
    $('#training-dataset').disabled = false;
    for (const selector of ['#training-profile-name', '#finetune-name', '#finetune-steps']) $(selector).disabled = false;
    $('#training-clips').setAttribute('aria-busy', 'false');
    if ($('#reload-training-datasets')) $('#reload-training-datasets').disabled = false;
    clearError();
    put('#training-summary', value.legacy ? `${value.displayName}의 확인을 마친 녹음 ${value.total}개로 학습합니다.`
      : `녹음 ${value.total}개 · 글이 있는 녹음 ${value.transcribed}개 · 자동 분석 완료 ${value.qualityReviewed || 0}개. 아래에서 하나씩 재생하고 들리는 말과 글을 맞춰 주세요.`);
    if (value.note) $('#training-summary').textContent += ` ${value.note}`;
    $('#training-profile-name').value = draft?.displayName ?? value.displayName;
    $('#finetune-name').value = draft?.name ?? `${value.id.slice(0, 56)}-${Date.now().toString(36)}`;
    if (draft) $('#finetune-steps').value = draft.maxSteps;
    for (const card of $('#training-clips').children) card.querySelector('audio').pause();
    $('#training-clips').replaceChildren();
    recommendedId = recommendedTrainingReference(value.clips);
    $('#training-recommendation').classList.toggle('hidden', !recommendedId);
    if (recommendedId) {
      const number = value.clips.findIndex(clip => clip.id === recommendedId) + 1;
      const clip = value.clips[number - 1];
      put('#training-reference-hint', `녹음 ${number}부터 들어보세요 · ${(clip.durationMs / 1000).toFixed(1)}초 · 자동 녹음 경고 없음. 평소 말투가 또렷하면 학습에 포함하고 대표 녹음으로 직접 선택하세요.`);
    }
    for (const [index, clip] of value.clips.entries()) {
      const previous = draft?.reviews.find(item => item.id === clip.id);
      const unchangedAudio = previous && sameAudio(previous.original, clip);
      const restoreText = unchangedAudio && previous.text !== previous.original.text;
      const accepted = unchangedAudio && previous.original.text === clip.text ? previous.accepted : !previous && clip.accepted;
      const card = element('article', 'training-clip');
      card.dataset.clipId = clip.id;
      const label = element('strong', '', `녹음 ${index + 1} · ${(clip.durationMs / 1000).toFixed(1)}초`);
      label.title = clip.id;
      const badges = element('div', 'training-assessments'); badges.dataset.assessment = '';
      const similarity = element('p', 'training-agreement'); similarity.dataset.agreement = '';
      const warnings = element('ul', 'training-warnings'); warnings.dataset.warnings = '';
      const audio = element('audio');
      audio.controls = true; audio.preload = 'none'; audio.src = clip.audioUrl;
      audio.setAttribute('aria-label', `녹음 ${index + 1} 듣기`);
      const text = element('textarea');
      text.value = restoreText ? previous.text : clip.text;
      text.maxLength = 2000;
      text.placeholder = '자동 분석으로 글을 채울 수 있습니다. 녹음을 듣고 실제로 들리는 말에 맞게 고쳐 주세요.';
      text.setAttribute('aria-label', `녹음 ${index + 1}의 글`);
      const editNote = element('small', 'training-review-note'); editNote.dataset.reviewNote = '';
      editNote.setAttribute('aria-live', 'polite');
      if (restoreText) editNote.textContent = '수정한 글을 유지했습니다. 들리는 말과 맞는지 확인해 주세요.';
      else if (previous && !accepted && previous.accepted) editNote.textContent = '녹음이나 글이 바뀌어 확인 표시를 해제했습니다. 다시 듣고 확인해 주세요.';
      const acceptLabel = element('label'), accept = element('input');
      accept.type = 'checkbox'; accept.checked = Boolean(accepted); accept.dataset.accept = '';
      accept.setAttribute('aria-label', `녹음 ${index + 1} 듣고 글을 확인하여 학습에 포함`);
      acceptLabel.append(accept, element('span', '', '듣고 글을 확인했습니다 · 학습에 포함'));
      const referenceLabel = element('label'), reference = element('input');
      reference.type = 'radio'; reference.name = 'training-reference'; reference.value = clip.id;
      reference.checked = (draft ? draft.referenceId : value.referenceId) === clip.id && Boolean(accepted);
      reference.setAttribute('aria-label', `녹음 ${index + 1}을 대표 녹음으로 선택`);
      referenceLabel.append(reference, element('span', '', '대표 녹음으로 선택 · 한 개만 선택'));
      const referenceHint = element('small', 'training-review-note'); referenceHint.dataset.referenceHint = '';
      referenceHint.id = `training-clip-${index + 1}-reference-hint`;
      reference.setAttribute('aria-describedby', referenceHint.id);
      const roles = element('div', 'training-role-controls'); roles.append(acceptLabel, referenceLabel, referenceHint);
      const comparison = element('details', 'training-comparison');
      comparison.append(element('summary', '', '자동 받아쓰기 비교와 녹음 측정값'),
        element('p', '', `첫 번째 받아쓰기: ${clip.quality?.sourceText || '분석 전'}`),
        element('p', '', `다른 방식의 받아쓰기: ${clip.quality?.independentText ?? '분석 전'}`));
      if (clip.quality?.audio) {
        const m = clip.quality.audio;
        comparison.append(element('p', '', `조용한 구간 ${Math.round(m.quietRatio * 100)}% · 평균 음량 ${m.rmsDbfs} dBFS · 음량 한계 신호 ${(m.clippingRatio * 100).toFixed(2)}%`));
      }
      card.append(label, badges, similarity, warnings, audio, element('small', '', '녹음에서 실제로 들리는 말'), text, editNote, comparison, roles);
      $('#training-clips').append(card);
      paintAssessment(card, clip);
      audio.addEventListener('play', () => {
        for (const other of $('#training-clips').children) if (other !== card) other.querySelector('audio').pause();
      });
      card.addEventListener('change', () => { clearError(); paintSelection(); rememberDraft(); });
      text.addEventListener('input', () => {
        accept.checked = false; reference.checked = false;
        editNote.textContent = '글을 수정해 확인 표시와 대표 녹음 선택을 해제했습니다. 녹음을 다시 듣고 ‘학습에 포함’을 체크해 주세요.';
        clearError(); paintAssessment(card, clip); paintSelection(); rememberDraft();
      });
    }
    paintSelection();
  }

  async function selectDataset() {
    const id = $('#training-dataset').value, ticket = ++request;
    clearError();
    unavailable('선택한 사람의 녹음을 불러오고 있습니다.', '녹음을 불러온 뒤 분석하거나 학습할 수 있습니다.', { busy: true });
    if (!id) {
      unavailable('준비된 학습용 녹음이 없습니다.', '한 사람의 녹음 파일을 불러와 주세요.', { empty: true });
      return;
    }
    try {
      const value = await api.readTrainingDataset(id);
      if (ticket === request) render(value);
    } catch (error) {
      if (ticket !== request) return;
      unavailable('녹음을 불러오지 못했습니다.', '다시 불러오기를 눌러 주세요. 계속 실패하면 한 사람의 녹음 파일을 새로 불러와 주세요.');
      showError(error);
    }
  }

  async function load() {
    const current = $('#training-dataset').value, ticket = ++request;
    clearError();
    unavailable('학습할 사람의 녹음 목록을 불러오고 있습니다.', '목록을 불러온 뒤 학습할 사람을 선택해 주세요.', { busy: true });
    $('#training-dataset').disabled = true;
    try {
      const choices = await api.listTrainingDatasets();
      if (ticket !== request) return;
      $('#training-dataset').replaceChildren(...choices.map(item => {
        const option = element('option', '', `${item.displayName} · 녹음 ${item.clips}개`);
        option.value = item.id;
        return option;
      }));
      $('#training-dataset').disabled = !choices.length;
      $('#training-dataset').value = choices.some(item => item.id === current) ? current : choices[0]?.id || '';
      if (choices.length) await selectDataset();
      else unavailable('준비된 학습용 녹음이 없습니다.', '한 사람의 녹음 파일을 불러와 주세요.', { empty: true });
    } catch (error) {
      if (ticket !== request) return;
      $('#training-dataset').replaceChildren();
      $('#training-dataset').disabled = true;
      unavailable('녹음 목록을 불러오지 못했습니다.', '다시 불러오기를 눌러 주세요. 학습은 시작되지 않았습니다.');
      showError(error);
    }
  }

  function options(mode = 'train') {
    const selected = selection(), reason = validation(mode, selected);
    if (reason) throw new Error(reason);
    rememberDraft();
    return { mode, datasetId: dataset.id, displayName: $('#training-profile-name').value.trim(),
      name: $('#finetune-name').value.trim(), maxSteps: Number($('#finetune-steps').value), ...selected };
  }

  function bind() {
    $('#training-dataset').addEventListener('change', selectDataset);
    $('#reload-training-datasets')?.addEventListener('click', load);
    $('#prepare-training').addEventListener('click', async () => {
      try { clearError(); await start(options('prepare')); } catch (error) { showError(error); }
    });
    for (const selector of ['#training-profile-name', '#finetune-name', '#finetune-steps']) {
      $(selector).addEventListener('input', () => { clearError(); paintSelection(); rememberDraft(); });
    }
    $('#listen-training-reference').addEventListener('click', async () => {
      const card = [...$('#training-clips').children].find(item => item.dataset.clipId === recommendedId);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        for (const other of $('#training-clips').children) if (other !== card) other.querySelector('audio').pause();
        try { await card.querySelector('audio').play(); } catch {
          showError(new Error('녹음을 재생하지 못했습니다. 녹음의 재생 버튼을 눌러 다시 들어 주세요.'));
        }
      }
    });
  }

  return { load, render, options, bind };
}
