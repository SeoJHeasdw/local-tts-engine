import { parseRegionTime, formatRegionTime, regionWindow, regionIssue, regionImpact, timeAtFraction } from "../../shared/regions.mjs";
import { findingStatus, voiceFindingReason, summarizeVoiceFindings, voiceFindingLabel, findingKeyOf, findingSeek, findingExcerpt } from "../view-utils.mjs";

export function createReviewController({ $, api, showToast, setEditBusy, $$, formatDuration, updateVoicePageMeta, mediaState, document = globalThis.document }) {
  let reviewTarget = null;
  let reviewFindings = [];
  let reviewSelection = null;
  let reviewMode = 'regenerate';
  let regionAudio = null;
  let reviewStopAt = null;
  let reviewRequest = 0;
  let reviewBusy = false;
  let latestCompleteReview = null;
  let pendingCandidateContext = null;
  let reviewResumeMs = 0;
  const reviewPlayer = $('#review-player');
  let reviewRangeEdited=false, reviewWaveWindow={start:0,end:10}, reviewWaveRequest=0;
  let regionPreviewRequest=0, regionPreviewBusy=false;

  // 다시 읽히기만으로 풀리지 않는 자리를 위해 사람이 적어 주는 발음문이다.
  // 자막·대본은 그대로 두고 읽는 말만 바꾼다.
  function readOverrideText() {
    return String($('#voice-override-text').value || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  }

  function setOverrideText(value, { open = false } = {}) {
    $('#voice-override-text').value = value || '';
    if (open) $('#voice-script-override').open = true;
    updateOverrideState();
  }

  function updateOverrideState() {
    const text = readOverrideText();
    $('#voice-override-badge').classList.toggle('hidden', !text);
    $('#voice-override-note').textContent = text
      ? '이 말로 후보를 만듭니다. 자동 판독의 대조 원문이 없으므로 직접 듣고 고르세요.'
      : '비워 두면 강의 대본 그대로 다시 읽습니다. 입력하면 자막·대본은 그대로 두고 읽는 말만 바꿉니다. 한국어와 영어를 함께 쓸 수 있습니다.';
  }

  function readReviewRegion() {
    return {start:parseRegionTime($('#review-mute-start').value),end:parseRegionTime($('#review-mute-end').value),
      duration:Number(mediaState.voiceVideo?.durationMs)/1000 || Number(reviewPlayer.duration) || Number(mediaState.voiceVideo?.pages?.at(-1)?.endMs)/1000 || 0,
      mode:reviewMode,audioDuration:regionAudio ? Number(regionAudio.durationMs)/1000 : null,
      fit:$('#review-region-fit').value || 'match-audio'};
  }
  function invalidateRegionPreview() {
    regionPreviewRequest++; regionPreviewBusy=false;
    $('#review-preview-player').pause(); $('#review-preview-player').removeAttribute('src');
    $('#review-preview-player').classList.add('hidden'); $('#review-preview-note').textContent='';
  }
  function setReviewRegion(start,end,{edited=true}={}) {
    $('#review-mute-start').value=formatRegionTime(start); $('#review-mute-end').value=formatRegionTime(end);
    reviewRangeEdited=edited; invalidateRegionPreview(); updateReviewAction(); drawReviewWaveSelection();
  }
  function drawReviewWaveSelection() {
    const r=readReviewRegion(),width=reviewWaveWindow.end-reviewWaveWindow.start;
    if(!(width>0))return;
    const position=t=>Math.max(0,Math.min(100,(t-reviewWaveWindow.start)/width*100));
    if(Number.isFinite(r.start)&&Number.isFinite(r.end)){
      const from=position(r.start),to=position(r.end);
      $('#review-wave-selection-band').style.left=`${from}%`; $('#review-wave-selection-band').style.width=`${Math.max(0,to-from)}%`;
      for(const side of ['start','end']){
        $('#review-wave-'+side).style.left=`${position(r[side])}%`;
        $('#review-wave-'+side).setAttribute('aria-label',`선택 ${side==='start'?'시작':'끝'} ${formatRegionTime(r[side])}, 방향키로 0.01초 이동`);
      }
    }
    $('#review-wave-cursor').style.left=`${position(reviewPlayer.currentTime)}%`;
  }
  async function showReviewWave(center,span=10) {
    const duration=readReviewRegion().duration;
    if(!mediaState.voiceVideo||!(duration>0))return;
    reviewWaveWindow=regionWindow(Number.isFinite(center)?center:reviewPlayer.currentTime,Number.isFinite(span)?span:10,duration);
    $('#review-wave-window').textContent=`${formatRegionTime(reviewWaveWindow.start)}–${formatRegionTime(reviewWaveWindow.end)}`;
    drawReviewWaveSelection(); $('#review-wave-path').setAttribute('d','');
    const request=++reviewWaveRequest,token=mediaState.voiceVideo.token;
    if(!api.reviewWaveform){$('#review-wave-note').textContent='앱을 다시 열면 파형을 불러올 수 있습니다.';return;}
    $('#review-wave-note').textContent='파형을 불러오고 있습니다.';
    try{
      const wave=await api.reviewWaveform({videoToken:token,...reviewWaveWindow});
      if(request!==reviewWaveRequest||token!==mediaState.voiceVideo?.token)return;
      const peak=Math.max(.001,...wave.peaks);
      $('#review-wave-path').setAttribute('d',wave.peaks.map((value,i)=>{
        const x=((i+.5)*1000/wave.peaks.length).toFixed(2),height=value/peak*46;
        return `M${x},${(50-height).toFixed(2)}V${(50+height).toFixed(2)}`;
      }).join(''));
      $('#review-wave-note').textContent='시작·끝 손잡이를 끌어 선택하세요. 방향키와 시간 입력으로 미세 조정할 수 있습니다.';
    }catch(error){if(request===reviewWaveRequest)$('#review-wave-note').textContent=error.message;}
  }
  function changeRegionBoundary(side,value) {
    const r=readReviewRegion();
    if(!Number.isFinite(value))return;
    $('#review-mute-'+side).value=formatRegionTime(Math.max(0,Math.min(r.duration,value)));
    reviewRangeEdited=true; invalidateRegionPreview(); updateReviewAction(); drawReviewWaveSelection();
  }
  async function previewReviewRegion(after=false,context=.6) {
    const r=readReviewRegion(),problem=regionIssue(after?r:{...r,mode:'replace',audioDuration:null});
    if(problem||regionPreviewBusy||!mediaState.voiceVideo||(after&&reviewMode==='replace'&&!regionAudio))return;
    if(!api.reviewPreview){showToast('앱을 다시 열어 미리듣기를 사용하세요.','error');return;}
    reviewPlayer.pause(); $('#region-audio-preview').pause(); $('#review-preview-player').pause();
    const request=++regionPreviewRequest,token=mediaState.voiceVideo.token;
    regionPreviewBusy=true; $('#review-preview-note').textContent='미리듣기를 준비하고 있습니다.'; updateReviewAction();
    try{
      const preview=await api.reviewPreview({videoToken:token,audioToken:regionAudio?.token,start:r.start,end:r.end,
        mode:after?reviewMode:'original',durationPolicy:r.fit,context});
      if(request!==regionPreviewRequest||token!==mediaState.voiceVideo?.token)return;
      const player=$('#review-preview-player');player.src=preview.audioUrl;player.playbackRate=Number($('#review-speed').value)||1;player.classList.remove('hidden');
      $('#review-preview-note').textContent=after?'수정 후 미리듣기 · 아직 저장하지 않았습니다.':context?'선택 구간 앞뒤 각 0.6초를 포함합니다.':'선택한 시작·끝으로 정확히 잘라 듣습니다.';
      await player.play();
    }catch(error){if(request===regionPreviewRequest)$('#review-preview-note').textContent=error.message;}
    finally{if(request===regionPreviewRequest){regionPreviewBusy=false;updateReviewAction();}}
  }

  // 고른 교체는 바로 파일로 굽지 않고 여기 모인다. 예전에는 한 곳을 고칠 때마다
  // 영상 전체를 다시 굽고 새 파일을 남긴 뒤 그 파일을 처음부터 다시 열었다.
  // 확인할 곳이 넷이면 그 값을 네 번 치렀다. 모아 두었다가 한 번에 적용하면
  // 재인코딩도 결과 파일도 하나로 끝난다.
  const pendingFixes = new Map();

  function pendingFixList() {
    return Array.from(pendingFixes.values()).sort((left, right) => left.startPage - right.startPage);
  }

  function renderPendingFixes() {
    const fixes = pendingFixList();
    paintRailFlags();
    renderReviewFacts();
    const badge = $('#polish-count');
    badge.textContent = String(fixes.length);
    badge.classList.toggle('hidden', fixes.length === 0);
    $('#polish-pending').classList.toggle('hidden', fixes.length === 0);
    $('#polish-pending-count').textContent = fixes.length ? `${fixes.length}곳 교체 대기` : '교체 대기 없음';
    $('#polish-save').disabled = reviewBusy || fixes.length === 0;
    $('#polish-pending-list').replaceChildren(...fixes.map((fix) => {
      const item = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = `${fix.startPage}페이지`;
      const detail = document.createElement('small');
      detail.textContent = fix.label;
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'polish-drop';
      drop.textContent = '취소';
      drop.setAttribute('aria-label', `${fix.startPage}페이지 교체 취소`);
      drop.addEventListener('click', () => dropPendingFix(fix.startPage));
      item.append(label, detail, drop);
      return item;
    }));
  }

  // 한 줄로 이 영상의 남은 일을 말한다. 이름·상태를 여러 자리에 나눠 적으면
  // 같은 사실을 세 번 읽게 되고, 정작 영상이 화면 아래로 밀린다.
  function renderReviewFacts() {
    const video = mediaState.voiceVideo;
    const facts = video ? [
      ['페이지', String((video.pages || []).length || '—')],
      ['확인할 곳', String(visibleFindings().length)],
      ...(pendingFixes.size ? [['교체 대기', String(pendingFixes.size)]] : []),
    ] : [];
    $('#polish-facts').replaceChildren(...facts.map(([key, value]) => {
      const span = document.createElement('span');
      const label = document.createElement('i');
      label.textContent = key;
      const strong = document.createElement('b');
      strong.textContent = value;
      span.append(label, strong);
      return span;
    }));
  }

  // Why it was flagged is the whole basis for the judgement, so it sits next to
  // the video rather than behind a disclosure.
  function showFindingDiff(finding) {
    const panel = $('#polish-diff');
    const expected = String(finding?.expectedText || '');
    const recognized = String(finding?.recognizedText || '');
    if (!expected && !recognized) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    $('#polish-expected').textContent = expected || '(원문 없음)';
    $('#polish-recognized').textContent = recognized || '(받아쓰기 없음)';
    $('#polish-diff-note').textContent = `${findingStatus(finding)} · ${voiceFindingReason(finding)}. 받아쓰기는 판독 근거이며, 실제 음성을 함께 확인하세요.`;
  }

  function queueSelectedCandidate(token, name) {
    if (!pendingCandidateContext || !token) return false;
    const startPage = Number(pendingCandidateContext.startPage);
    const endPage = Number(pendingCandidateContext.endPage ?? startPage);
    if (!Number.isFinite(startPage)) return false;
    pendingFixes.set(startPage, {
      startPage,
      endPage,
      audioToken: token,
      label: name || '고른 목소리',
    });
    pendingCandidateContext = null;
    autoOpened = false;
    setOverrideText('');
    $('#voice-script-override').open = false;
    $('#review-candidates-host').classList.add('hidden');
    // 교체를 담았다면 그 페이지는 처리된 것이므로 목록에서도 내린다.
    reviewFindings
      .filter((finding) => Number(finding.slideNumber) === startPage)
      .forEach((finding) => clearedFindings.add(findingKey(finding)));
    renderFindings();
    renderPendingFixes();
    showToast(`${startPage}페이지 교체를 대기 목록에 담았습니다. 저장할 때 한 번에 적용됩니다.`);
    return true;
  }

  async function savePendingFixes() {
    const fixes = pendingFixList();
    if (!mediaState.voiceVideo || !fixes.length || reviewBusy) return;
    const payload = {
      operation: 'voice-pages',
      name: `polish-${Date.now()}`,
      videoToken: mediaState.voiceVideo.token,
      durationPolicy: $('#voice-duration-policy').value,
      patches: fixes.map((fix) => ({ startPage: fix.startPage, endPage: fix.endPage, audioToken: fix.audioToken })),
    };
    reviewPlayer.pause();
    try { setEditBusy(true); await api.startEdit(payload); }
    catch (error) { setEditBusy(false); showToast(error.message, 'error'); }
  }

  // 담아 둔 교체를 취소하면 그 페이지의 확인 항목도 도로 올라와야 한다.
  // 담을 때 '처리된 자리'로 내렸으니, 되돌릴 때 함께 되돌리지 않으면 남은 일이
  // 목록에서 사라진 채로 남는다.
  function dropPendingFix(startPage) {
    pendingFixes.delete(Number(startPage));
    for (const finding of reviewFindings) {
      if (Number(finding.slideNumber) === Number(startPage)) clearedFindings.delete(findingKey(finding));
    }
    renderFindings();
    renderPendingFixes();
  }

  $('#polish-save').addEventListener('click', savePendingFixes);
  $('#polish-discard').addEventListener('click', () => {
    for (const startPage of [...pendingFixes.keys()]) dropPendingFix(startPage);
  });


  function renderCompleteVoiceFindings(findings = [], target = null) {
    latestCompleteReview = target;
    const summary = summarizeVoiceFindings(findings);
    $('#voice-quality-panel').classList.toggle('hidden', summary.total === 0);
    $('#voice-quality-panel').dataset.tone = summary.tone;
    $('#voice-quality-title').textContent = summary.title;
    $('#review-latest').classList.toggle('hidden', !target);
    $('#voice-quality-list').classList.toggle('hidden', Boolean(target));
    $('#voice-quality-list').replaceChildren(...(target ? [] : findings.map(finding => {
      const item = document.createElement('li');
      const label = `${finding.displayName ? `${finding.displayName} · ` : ''}${voiceFindingLabel(finding)} · ${finding.slideNumber}페이지 · ${voiceFindingReason(finding)}`;
      if (finding.target) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.addEventListener('click', () => openReview(finding.target)); item.append(button);
      } else item.textContent = label;
      return item;
    })));
  }

  // 목록에 남아 있는 것이 곧 남은 일이다. 들어 보고 문제 없다고 판단했거나
  // 교체를 담은 항목은 그 자리에서 지워야, 무엇이 남았는지가 목록만 봐도 읽힌다.
  // 판정 자체를 바꾸는 것이 아니라 이 영상을 보는 동안의 표시일 뿐이라, 다른
  // 영상을 열면 초기화된다.
  const clearedFindings = new Set();

  function findingKey(finding) {
    return findingKeyOf(finding);
  }

  // 표시는 결과에 적힌다. 그래야 앱을 다시 켜도, 최근 결과에서 봐도 같은 상태다.
  async function persistClearedFindings() {
    const target = mediaState.voiceVideo?.reviewTarget;
    if (!target) return;
    try { await api.setClearedFindings(target, [...clearedFindings]); }
    catch (error) { showToast(`확인 표시를 저장하지 못했습니다. ${error.message}`, 'error'); }
  }

  function visibleFindings() {
    return reviewFindings.filter((finding) => !clearedFindings.has(findingKey(finding)));
  }

  // 확인할 곳이 여섯이면 여섯 줄이 한꺼번에 펼쳐져 사이드바를 가득 채웠고,
  // 그 안에서 확인·재생성·사유·대본은 22픽셀 아이콘으로 밀려났다. 같은 페이지의
  // 여러 지적은 결국 그 페이지를 한 번 다시 읽히는 한 가지 일이므로, 페이지로
  // 묶어 접어 두고 펼친 자리에서만 버튼을 제대로 세운다.
  let expandAll = false;
  // 한 곳만 남았을 때는 펼쳐 둔다. 다만 목록을 다시 그릴 때마다 페이지를 새로
  // 고르면 적어 둔 읽을 말이 지워지므로, 영상을 연 뒤 한 번만 한다.
  let autoOpened = false;

  function findingGroups(findings) {
    const groups = new Map();
    for (const finding of findings) {
      const number = Number(finding.slideNumber);
      const group = groups.get(number) || { number, findings: [] };
      group.findings.push(finding);
      groups.set(number, group);
    }
    return [...groups.values()].sort((left, right) => left.number - right.number);
  }

  function renderFindings() {
    const remaining = visibleFindings();
    const cleared = reviewFindings.length - remaining.length;
    const groups = findingGroups(remaining);
    $('#review-finding-count').textContent = String(remaining.length);
    const openFirst = !autoOpened && groups.length === 1;
    if (openFirst) autoOpened = true;
    const rows = groups.map((group, index) => renderFindingGroup(group, openFirst && index === 0));
    if (cleared > 0) {
      const note = document.createElement('li');
      note.className = 'findings-cleared';
      const mark = document.createElement('b');
      mark.textContent = '✓';
      const label = document.createElement('span');
      label.textContent = `${cleared}곳 확인함`;
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.textContent = '되돌리기';
      undo.addEventListener('click', restoreClearedFindings);
      note.append(mark, label, undo);
      rows.push(note);
    }
    $('#review-findings-list').replaceChildren(...rows);
    $('#review-findings-expand').classList.toggle('hidden', groups.length < 2);
    $('#review-findings-expand').textContent = expandAll ? '모두 접기' : '모두 펼치기';
    $('#review-findings-expand').setAttribute('aria-expanded', String(expandAll));
    paintRailFlags();
    renderReviewFacts();
    $('#review-findings-note').textContent = reviewFindings.length === 0
      ? '표시된 자동 검수 항목이 없습니다. 검사가 놓칠 수 있으니 직접 듣고 확인하세요.'
      : remaining.length === 0
        ? '확인할 항목을 모두 정리했습니다. 담아 둔 교체가 있으면 저장하세요.'
        : `자동 검수 권장 ${remaining.length}곳 · ${groups.length}페이지입니다. 페이지를 펼쳐 듣고 확인하세요.`;
  }

  $('#review-findings-expand').addEventListener('click', () => {
    expandAll = !expandAll;
    renderFindings();
  });

  function pageOf(finding) {
    return mediaState.voiceVideo?.pages?.find(page => page.number === Number(finding.slideNumber)) || null;
  }

  // 한 페이지의 지적들. 접힌 줄만 보고도 어느 페이지의 무슨 일인지 읽히도록
  // 페이지·시각·판정만 요약에 둔다.
  function renderFindingGroup(group, open = false) {
    const row = document.createElement('li');
    const worst = group.findings.some(finding => finding.severity !== 'warning') ? 'failed' : 'warning';
    row.className = 'finding-group';
    row.dataset.severity = worst;

    const details = document.createElement('details');
    details.open = expandAll || open;
    const summary = document.createElement('summary');
    const page = pageOf(group.findings[0]);
    const at = findingSeek(group.findings[0], page);

    const title = document.createElement('strong');
    title.textContent = `${group.number}페이지`;
    const count = document.createElement('span');
    count.className = 'finding-count';
    count.textContent = `${group.findings.length}곳`;
    count.classList.toggle('hidden', group.findings.length < 2);
    const time = document.createElement('span');
    time.className = 'finding-time';
    time.textContent = voiceFindingLabel(at);
    const verdict = document.createElement('span');
    verdict.className = 'finding-verdict';
    verdict.textContent = worst === 'failed' ? '재생성 필요' : '청취 확인';
    summary.append(title, count, verdict, time);

    const body = document.createElement('div');
    body.className = 'finding-body';
    body.append(...group.findings.map(renderVoiceFindingRow));

    // 버튼은 페이지 단위다. 같은 페이지의 지적 둘을 따로 재생성할 수는 없다.
    const tools = document.createElement('div');
    tools.className = 'finding-tools';
    const done = document.createElement('button');
    done.type = 'button'; done.className = 'finding-done';
    done.textContent = group.findings.length > 1 ? '이 페이지 확인' : '확인';
    done.title = '확인 완료로 표시';
    done.setAttribute('aria-label', `${group.number}페이지 확인 완료로 표시`);
    done.addEventListener('click', () => clearFindings(group.findings));
    // 확인 항목의 대부분은 결국 그 페이지를 다시 읽히는 것으로 끝난다. 화면을
    // 옮겨 페이지를 다시 고르는 두 걸음을 지우고 그 자리에 버튼을 둔다.
    const again = document.createElement('button');
    again.type = 'button'; again.className = 'finding-regenerate';
    again.textContent = '재생성';
    again.title = '이 페이지의 목소리를 대본 그대로 새로 만듭니다';
    again.setAttribute('aria-label', `${group.number}페이지 목소리 재생성`);
    again.disabled = !page;
    again.addEventListener('click', () => regenerateFinding(group.findings[0], page));
    // 다시 읽혀도 같은 자리에서 같게 읽히는 말이 있다. 그때는 읽을 말을 사람이
    // 적는다. 기본은 여전히 재생성이고, 이 버튼은 그 입력칸을 여는 일만 한다.
    const rewrite = document.createElement('button');
    rewrite.type = 'button'; rewrite.className = 'finding-rewrite';
    rewrite.textContent = '읽는 말 바꿔 재생성';
    rewrite.title = '읽을 말을 직접 적어 이 페이지를 다시 만듭니다';
    rewrite.setAttribute('aria-label', `${group.number}페이지 읽는 말 바꿔 재생성`);
    rewrite.disabled = !page;
    rewrite.addEventListener('click', () => rewriteFinding(group.findings[0], page));
    tools.append(done, again, rewrite);
    body.append(tools);

    details.append(summary, body);
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      if (!expandAll) {
        for (const other of $$('#review-findings-list details')) {
          if (other !== details) other.open = false;
        }
      }
      openFinding(group.findings[0], page, at);
    });
    row.append(details);
    // 모두 펼치기는 보기만 넓히는 일이다. 펼친 마지막 페이지가 고칠 자리를
    // 빼앗으면, 방금 고르던 페이지가 조용히 바뀐다.
    if (open) openFinding(group.findings[0], page, at, { seek: false });
    return row;
  }

  // 펼치는 것과 그 자리를 듣는 것은 한 동작이다. 펼쳐 놓고 다시 눌러야
  // 들린다면 목록은 그냥 목차일 뿐이다.
  function openFinding(finding, page, at, { seek = true } = {}) {
    selectReviewPage(page, voiceFindingReason(finding));
    showFindingDiff(finding);
    if (!seek) return;
    // 항목의 구간은 청크 전체다. 그대로 옮기면 문단 첫머리에 떨어져 문제가 된
    // 낱말을 다시 찾아야 한다. 낱말 시각이 있으면 그 자리로 간다.
    seekReview(at.startMs / 1000, at.endMs / 1000);
    setReviewRegion(at.startMs / 1000, at.endMs / 1000);
    if (reviewMode !== 'regenerate') showReviewWave((at.startMs + at.endMs) / 2000, (at.endMs - at.startMs) / 1000 + 2);
  }

  function clearFinding(finding) {
    clearFindings([finding]);
  }

  function clearFindings(findings) {
    for (const finding of findings) clearedFindings.add(findingKey(finding));
    renderFindings();
    persistClearedFindings();
  }

  function restoreClearedFindings() {
    clearedFindings.clear();
    renderFindings();
    persistClearedFindings();
  }

  // 판정과 사유, 그리고 걸린 낱말이 있는 문장. 접혀 있던 것을 펼친 자리이므로
  // 사유를 아이콘 뒤에 숨기지 않고 그대로 읽힌다.
  function renderVoiceFindingRow(finding) {
    const item = document.createElement('article');
    item.className = 'finding-item';
    item.dataset.severity = finding.severity;

    const status = document.createElement('p');
    status.className = 'finding-status';
    status.textContent = findingStatus(finding);

    const why = document.createElement('p');
    why.className = 'finding-why';
    why.textContent = voiceFindingReason(finding);

    // 대본을 통째로 말면 어느 낱말을 들어야 하는지가 오히려 묻힌다. 걸린 낱말과
    // 그 앞뒤만 짧게 보여 준다.
    const line = document.createElement('p');
    line.className = 'finding-line';
    const excerpt = findingExcerpt(finding);
    const paintExcerpt = () => {
      line.replaceChildren();
      if (excerpt?.term) {
        const before = document.createElement('span'); before.textContent = excerpt.before;
        const term = document.createElement('mark'); term.className = 'finding-term'; term.textContent = excerpt.term;
        const after = document.createElement('span'); after.textContent = excerpt.after;
        line.append(before, term, after);
      } else {
        line.textContent = excerpt?.after || voiceFindingReason(finding);
      }
    };
    paintExcerpt();

    // 발췌는 걸린 낱말을 짚으려고 앞뒤를 잘랐다. 잘린 데가 궁금할 때를 위해
    // 펼칠 수 있게 둔다.
    const full = String(finding.expectedText || '').trim();
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'finding-more';
    more.textContent = '대본 전체 보기';
    more.setAttribute('aria-expanded', 'false');
    more.disabled = !full;
    more.addEventListener('click', () => {
      const open = more.getAttribute('aria-expanded') !== 'true';
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? '발췌만 보기' : '대본 전체 보기';
      line.classList.toggle('full', open);
      if (open) { line.replaceChildren(); line.textContent = full; }
      else paintExcerpt();
    });

    const listen = document.createElement('button');
    listen.type = 'button';
    listen.className = 'finding-listen';
    listen.textContent = '이 자리 듣기';
    const page = pageOf(finding);
    const at = findingSeek(finding, page);
    listen.setAttribute('aria-label', `${finding.slideNumber}페이지 ${voiceFindingLabel(at)} 듣기`);
    listen.addEventListener('click', () => {
      openFinding(finding, page, at);
      playReviewRange(at.startMs / 1000, at.endMs / 1000);
    });

    const actions = document.createElement('div');
    actions.className = 'finding-item-actions';
    actions.append(listen, more);
    item.append(status, why, line, actions);
    return item;
  }

  async function openReview(target, finding = null) {
    const request = ++reviewRequest;
    try {
      const video = await api.adoptResultVideo(target);
      if (request !== reviewRequest || reviewBusy) return false;
      setReviewVideo(video, target);
      $("[data-view='review']").click();
      if (finding) {
        selectReviewPage(video.pages?.find(p => p.number === Number(finding.slideNumber)), voiceFindingReason(finding));
        seekReview(Number(finding.startMs) / 1000, Number(finding.endMs) / 1000);
      }
      return true;
    } catch (error) { showToast(error.message, 'error'); return false; }
  }

  // 검수 중인 파일도 이름은 그 자리에서 고친다. 결과 목록을 거치지 않고 고른
  // 영상이어도 이름은 그 파일에 붙은 것이므로 같은 방법으로 바꿀 수 있다.
  function paintReviewFileName(name) {
    const element = $('#voice-video-name');
    element.replaceChildren();
    element.textContent = name;
    element.classList.toggle('renamable', Boolean(mediaState.voiceVideo));
    element.title = mediaState.voiceVideo ? `${name} · 더블클릭해서 이름 바꾸기` : '';
  }

  function setReviewVideo(video, target = null) {
    if (!video || reviewBusy) return;
    $$('audio,video').forEach(media => media.pause());
    mediaState.voiceVideo = video; reviewTarget = target; reviewSelection = null; reviewStopAt = null;
    reviewMode = 'regenerate';
    reviewWaveRequest++; invalidateRegionPreview(); reviewRangeEdited=false;
    $('#review-region-wave').classList.add('hidden');
    $$('#review-mode-tabs button').forEach(button => button.classList.toggle('selected', button.dataset.repairMode === reviewMode));
    $('#edit-voice-panel').classList.remove('hidden');
    $('#review-mute-panel').classList.add('hidden');
    $('#review-mute-start').value = '0:00.000'; $('#review-mute-end').value = '0:00.200';
    $('#review-region-fit').value='match-audio';
    regionAudio = null;
    $('#region-audio-preview').removeAttribute('src');
    $('#region-audio-preview').classList.add('hidden');
    $('#region-audio-name').textContent = 'WAV·M4A·MP3 파일을 선택하세요.';
    pendingCandidateContext = null;
    autoOpened = false;
    setOverrideText('');
    $('#voice-script-override').open = false;
    $('#review-candidates-host').classList.add('hidden');
    $('#review-saved').classList.add('hidden');
    pendingFixes.clear();
    renderPendingFixes();
    $('#polish-diff').classList.add('hidden');
    paintReviewFileName(video.name);
    reviewPlayer.src = video.videoUrl;
    reviewFindings = video.voiceFindings || [];
    clearedFindings.clear();
    for (const key of video.clearedFindings || []) clearedFindings.add(String(key));
    renderPageRail(video);
    $('#review-selection-title').textContent = '고칠 페이지를 고르세요';
    $('#review-selection-reason').textContent = '확인할 부분에서 고르거나, 영상 아래 페이지 막대에서 누르세요.';
    $('#review-player-status').textContent = video.pages?.length ? '재생 중에도 페이지를 선택해 수정할 수 있습니다.' : '페이지 정보가 없어 재생성은 사용할 수 없습니다. 구간 무음 처리는 가능합니다.';
    // 한 곳만 남은 목록은 펼친 채로 그 페이지를 골라 둔다. 기본 문구를 세운
    // 뒤에 그려야 고른 페이지가 다시 '선택하세요'로 덮이지 않는다.
    renderFindings();
    updateReviewPosition(); updateReviewAction();
  }

  // 100칸이 넘는 페이지를 버튼 이름으로 늘어놓으면 목록이 화면 한 판을 먹고,
  // 정작 고르려는 페이지는 눈으로 세어야 찾힌다. 한 칸이 한 페이지인 막대로
  // 두고, 확인할 곳만 색으로 세운다. 정확한 이동은 옆의 번호 입력이 맡는다.
  const RAIL_LABEL_LIMIT = 26;

  const railCells = new Map();
  let railCurrent = null;
  let positionPage = null;

  function renderPageRail(video) {
    const pages = video?.pages || [];
    const dense = pages.length > RAIL_LABEL_LIMIT;
    railCells.clear();
    railCurrent = null;
    $('#review-pages').classList.toggle('dense', dense);
    $('#review-pages').replaceChildren(...pages.map(page => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.dataset.page = page.number;
      if (!dense) cell.textContent = String(page.number);
      cell.title = `${page.number}페이지 · ${formatDuration(page.startMs)} · ${String(page.text || '').slice(0, 70)}`;
      cell.setAttribute('aria-label', `${page.number}페이지 · ${formatDuration(page.startMs)}`);
      cell.addEventListener('click', () => { selectReviewPage(page); seekReview(page.startMs / 1000); });
      railCells.set(page.number, cell);
      return cell;
    }));
    const first = pages[0]?.number;
    const last = pages.at(-1)?.number;
    $('#review-page-total').textContent = pages.length ? `${first}–${last}` : '';
    $('#review-page-jump').min = String(first ?? 1);
    $('#review-page-jump').max = String(last ?? 1);
    $('#review-page-jump').disabled = !pages.length;
    for (const id of ['review-page-prev', 'review-page-next']) $('#' + id).disabled = !pages.length;
    positionPage = null;
    paintRailFlags();
  }

  function paintRailFlags() {
    const flagged = new Map();
    for (const finding of visibleFindings()) {
      const number = Number(finding.slideNumber);
      if (finding.severity !== 'warning' || !flagged.has(number)) {
        flagged.set(number, finding.severity === 'warning' ? 'warning' : 'failed');
      }
    }
    const fixed = new Set([...pendingFixes.keys()].map(Number));
    let failed = 0, warned = 0;
    for (const cell of $$('#review-pages button')) {
      const number = Number(cell.dataset.page);
      const severity = flagged.get(number);
      cell.classList.toggle('flagged', severity === 'failed');
      cell.classList.toggle('advised', severity === 'warning');
      cell.classList.toggle('queued', fixed.has(number));
      if (severity === 'failed') failed += 1;
      if (severity === 'warning') warned += 1;
    }
    const legend = [failed ? `재생성 필요 ${failed}` : '', warned ? `청취 확인 ${warned}` : '',
      fixed.size ? `교체 대기 ${fixed.size}` : ''].filter(Boolean);
    $('#page-rail-legend').textContent = legend.join(' · ');
  }

  function movePage(step) {
    const pages = mediaState.voiceVideo?.pages || [];
    if (!pages.length) return;
    const current = currentReviewPage();
    const index = current ? pages.indexOf(current) : -1;
    const next = pages[Math.max(0, Math.min(pages.length - 1, (index < 0 ? 0 : index) + step))];
    if (next) { selectReviewPage(next); seekReview(next.startMs / 1000); }
  }

  $('#review-page-prev').addEventListener('click', () => movePage(-1));
  $('#review-page-next').addEventListener('click', () => movePage(1));
  $('#review-page-jump').addEventListener('change', () => {
    const pages = mediaState.voiceVideo?.pages || [];
    const wanted = Number($('#review-page-jump').value);
    const page = pages.find(item => Number(item.number) === wanted);
    if (!page) { updateReviewPosition(); return; }
    selectReviewPage(page);
    seekReview(page.startMs / 1000);
  });

  function currentReviewPage() {
    const pages = mediaState.voiceVideo?.pages || [];
    const ms = reviewPlayer.currentTime * 1000;
    return pages.find((page, index) => ms >= (index ? page.startMs : 0) && ms < (pages[index + 1]?.startMs ?? Infinity)) || null;
  }
  // 재생 중에는 초당 네 번 불린다. 시각만 매번 바뀌므로 페이지가 실제로 넘어간
  // 때에만 막대·대본·번호를 손댄다. 매번 백 칸을 훑으면 재생이 그만큼 무거워진다.
  function markRailCurrent(page) {
    const next = page ? railCells.get(page.number) || null : null;
    if (railCurrent === next) return;
    if (railCurrent) { railCurrent.classList.remove('current'); railCurrent.setAttribute('aria-current', 'false'); }
    if (next) { next.classList.add('current'); next.setAttribute('aria-current', 'true'); }
    railCurrent = next;
  }

  function updateReviewPosition() {
    const page = currentReviewPage();
    $('#review-current-page').textContent = page ? `${page.number}페이지 · ${Math.floor(reviewPlayer.currentTime / 60)}:${(reviewPlayer.currentTime % 60).toFixed(2).padStart(5, '0')}` : '페이지 정보 없음';
    $('#review-select-page').disabled = reviewBusy || !page;
    if (page?.number !== positionPage) {
      positionPage = page?.number;
      $('#review-script').textContent = page?.text || '페이지 타임라인이 없는 영상입니다.';
      markRailCurrent(page);
      // 입력 중인 숫자를 빼앗지 않는다.
      if (page && document.activeElement !== $('#review-page-jump')) $('#review-page-jump').value = String(page.number);
    }
    if(reviewMode!=='regenerate')drawReviewWaveSelection();
  }
  function selectReviewPage(page, reason = '') {
    if (!page || reviewBusy) return;
    // 적어 둔 읽을 말은 그 페이지의 것이다. 다른 페이지로 옮기면 지운다.
    if (reviewSelection && reviewSelection.number !== page.number) setOverrideText('');
    reviewPlayer.pause(); reviewSelection = page;
    $('#voice-start-page').value = $('#voice-end-page').value = String(page.number);
    $('#review-selection-title').textContent = `${page.number}페이지 고치기`;
    $('#review-selection-reason').textContent = reason || `${formatDuration(page.startMs)}–${formatDuration(page.endMs)} · 직접 선택한 페이지`;
    updateVoicePageMeta(); updateReviewAction();
  }
  function updateReviewAction() {
    const r=readReviewRegion(),problem=reviewMode==='regenerate'?'':regionIssue(r);
    $('#review-region-error').textContent=problem;
    $('#review-region-duration').textContent=Number.isFinite(r.end-r.start)&&r.end>r.start?`선택 길이 ${(r.end-r.start).toFixed(3)}초`:'';
    $('#review-region-impact').textContent=regionImpact(r.start,r.end,r.audioDuration,r.fit);
    const valid=Boolean(mediaState.voiceVideo)&&!problem&&!reviewBusy&&!regionPreviewBusy;
    $('#start-review-button').disabled = !valid || (reviewMode === 'regenerate' && !reviewSelection) || (reviewMode === 'replace' && !regionAudio);
    const canListen=Boolean(mediaState.voiceVideo)&&!regionIssue({...r,mode:'replace',audioDuration:null})&&!reviewBusy&&!regionPreviewBusy;
    for(const id of ['review-range-exact','review-range-play'])$('#'+id).disabled=!canListen;
    $('#review-result-play').disabled=!valid||(reviewMode==='replace'&&!regionAudio);
    $('#review-result-play').textContent=reviewMode==='mute'?'무음 처리 후 듣기':'교체 후 앞뒤 듣기';
    $('#review-range-page').disabled=!mediaState.voiceVideo?.pages?.length||reviewBusy;
    $('#review-original').disabled = !reviewSelection || reviewBusy;
    $('#start-review-label').textContent = reviewMode === 'mute' ? '선택 구간을 무음 처리한 새 버전 저장'
      : reviewMode === 'replace' ? '선택 구간의 음성을 교체한 새 버전 저장'
        : readOverrideText() ? '입력한 말로 후보 만들기' : '새 목소리 후보 만들기';
    $('#review-form .review-save-note').textContent = reviewMode !== 'regenerate'
      ? '원본을 보관하고 수정본을 새 버전으로 저장합니다.' : '후보를 듣고 선택한 뒤 새 버전으로 저장합니다. 원본은 보관됩니다.';
  }
  function seekReview(start, end = null) {
    reviewPlayer.pause(); reviewStopAt = end;
    const seek = () => { reviewPlayer.currentTime = Math.max(0, start); updateReviewPosition(); };
    if (reviewPlayer.readyState >= 1) seek();
    else reviewPlayer.addEventListener('loadedmetadata', seek, {once:true});
  }
  async function playReviewRange(start, end) {
    seekReview(start, end);
    try { await reviewPlayer.play(); } catch { showToast('영상의 재생 버튼을 눌러 주세요.', 'error'); }
  }
  reviewPlayer.addEventListener('timeupdate', () => {
    updateReviewPosition();
    if (reviewStopAt != null && reviewPlayer.currentTime >= reviewStopAt) { reviewPlayer.pause(); reviewStopAt = null; }
  });
  reviewPlayer.addEventListener('loadedmetadata', () => {
    reviewPlayer.playbackRate = Number($('#review-speed').value)||1;
    if(reviewMode!=='regenerate'&&!reviewRangeEdited){const start=Math.min(reviewPlayer.currentTime,Math.max(0,readReviewRegion().duration-.2));setReviewRegion(start,Math.min(readReviewRegion().duration,start+.2),{edited:false});}
    updateReviewPosition();updateReviewAction();
  });
  reviewPlayer.addEventListener('error', () => { $('#review-player-status').textContent = '영상을 열지 못했습니다. 원본 파일 위치를 확인해 주세요.'; });
  $('#review-select-page').addEventListener('click', () => selectReviewPage(currentReviewPage()));
  $('#review-back').addEventListener('click', () => seekReview(Math.max(0, reviewPlayer.currentTime - 5)));
  $('#review-fine-back').addEventListener('click', () => seekReview(Math.max(0, reviewPlayer.currentTime - .01)));
  $('#review-fine-next').addEventListener('click', () => seekReview(Math.min(readReviewRegion().duration, reviewPlayer.currentTime + .01)));
  $('#review-speed').addEventListener('change', () => {
    for(const player of [reviewPlayer,$('#review-preview-player'),$('#region-audio-preview')])player.playbackRate=Number($('#review-speed').value)||1;
  });
  $('#review-original').addEventListener('click', () => reviewSelection && playReviewRange(reviewSelection.startMs / 1000, reviewSelection.endMs / 1000));
  $('#review-latest').addEventListener('click', () => latestCompleteReview && openReview(latestCompleteReview));
  function setReviewMode(mode) {
    reviewMode = mode;
    $$('#review-mode-tabs button').forEach(b => b.classList.toggle('selected', b.dataset.repairMode === mode));
    $('#edit-voice-panel').classList.toggle('hidden', reviewMode !== 'regenerate');
    $('#review-mute-panel').classList.toggle('hidden', reviewMode === 'regenerate');
    $('#review-replacement-panel').classList.toggle('hidden', reviewMode !== 'replace');
    $('#review-region-wave').classList.toggle('hidden',reviewMode==='regenerate');
    $('#review-region-description').textContent = reviewMode === 'replace' ? '단어·구절의 음성을 준비한 파일로 교체합니다. 길이가 달라지면 화면·자막도 함께 조정할 수 있습니다.' : '불필요한 소리만 무음으로 바꿉니다. 영상 길이와 자막 시각은 유지됩니다.';
    $('#review-region-limit').textContent = reviewMode === 'replace' ? '0.05~120초를 선택하세요. 누락을 복원할 때는 앞뒤 문맥을 포함한 같은 원문의 음성을 준비하세요.' : '0.05~2초를 선택하세요. 정상 발화가 포함되지 않았는지 앞뒤를 들어 보세요.';
    invalidateRegionPreview();
    if(reviewMode!=='regenerate'){
      const duration=readReviewRegion().duration;
      if(!reviewRangeEdited){const start=Math.min(reviewPlayer.currentTime,Math.max(0,duration-.2));setReviewRegion(start,Math.min(duration,start+(reviewMode==='mute'?.2:2)),{edited:false});}
      const r=readReviewRegion();showReviewWave((r.start+r.end)/2,Math.max(5,r.end-r.start+2));
    }
    updateReviewAction();
  }
  $$('#review-mode-tabs button').forEach(button => button.addEventListener('click', () => setReviewMode(button.dataset.repairMode)));
  $('#pick-region-audio').addEventListener('click', async () => {
    try {
      const videoToken = mediaState.voiceVideo?.token;
      const [audio] = await api.pickAudio();
      if (!audio || reviewBusy || videoToken !== mediaState.voiceVideo?.token) return;
      regionAudio = audio;
      invalidateRegionPreview();
      $('#region-audio-name').textContent = `${audio.name}${audio.durationMs?` · ${(audio.durationMs/1000).toFixed(3)}초`:''}`;
      $('#region-audio-preview').src = audio.audioUrl;
      $('#region-audio-preview').classList.remove('hidden');
      updateReviewAction();
    } catch (error) { showToast(error.message, 'error'); }
  });
  for(const side of ['start','end']){
    const field=$('#review-mute-'+side);
    field.addEventListener('input',()=>{reviewRangeEdited=true;invalidateRegionPreview();updateReviewAction();drawReviewWaveSelection();});
    field.addEventListener('blur',()=>{const value=parseRegionTime(field.value);if(Number.isFinite(value))field.value=formatRegionTime(value);});
    field.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();changeRegionBoundary(side,readReviewRegion()[side]+(event.key==='ArrowUp'?1:-1)*(event.shiftKey?.1:.01));});
    $('#review-mark-'+side).addEventListener('click',()=>{reviewPlayer.pause();changeRegionBoundary(side,reviewPlayer.currentTime);});
    for(const [suffix,delta] of [['back',-.01],['next',.01]])$('#review-'+side+'-'+suffix).addEventListener('click',()=>changeRegionBoundary(side,readReviewRegion()[side]+delta));
    const handle=$('#review-wave-'+side);
    handle.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();changeRegionBoundary(side,readReviewRegion()[side]+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?.1:.01));});
    let pointer=null;
    handle.addEventListener('pointerdown',event=>{if(reviewBusy)return;pointer=event.pointerId;handle.setPointerCapture(pointer);reviewPlayer.pause();});
    handle.addEventListener('pointermove',event=>{
      if(pointer!==event.pointerId||reviewBusy)return;
      const rect=$('#review-wave-track').getBoundingClientRect(),r=readReviewRegion();
      let value=timeAtFraction((event.clientX-rect.left)/rect.width,reviewWaveWindow);
      value=side==='start'?Math.min(value,r.end-.05):Math.max(value,r.start+.05);
      changeRegionBoundary(side,value);
    });
    for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,()=>{pointer=null;});
  }
  $('#review-range-exact').addEventListener('click',()=>previewReviewRegion(false,0));
  $('#review-range-play').addEventListener('click',()=>previewReviewRegion(false,.6));
  $('#review-result-play').addEventListener('click',()=>previewReviewRegion(true,.6));
  $('#review-region-fit').addEventListener('change',()=>{invalidateRegionPreview();updateReviewAction();});
  $('#review-range-page').addEventListener('click',()=>{const page=currentReviewPage();if(!page)return;setReviewRegion(page.startMs/1000,page.endMs/1000);showReviewWave((page.startMs+page.endMs)/2000,(page.endMs-page.startMs)/1000+2);});
  for(const [id,factor] of [['review-wave-in',.5],['review-wave-out',2]])$('#'+id).addEventListener('click',()=>showReviewWave((reviewWaveWindow.start+reviewWaveWindow.end)/2,(reviewWaveWindow.end-reviewWaveWindow.start)*factor));
  $('#review-wave-selection').addEventListener('click',()=>{const r=readReviewRegion();if(Number.isFinite(r.start+r.end))showReviewWave((r.start+r.end)/2,r.end-r.start+.5);});
  $('#review-wave-current').addEventListener('click',()=>showReviewWave(reviewPlayer.currentTime));
  $('#review-wave-track').addEventListener('click',event=>{if(event.target.closest?.('.wave-handle'))return;const rect=$('#review-wave-track').getBoundingClientRect();seekReview(timeAtFraction((event.clientX-rect.left)/rect.width,reviewWaveWindow));});
  reviewPlayer.addEventListener('play',()=>{ $('#review-preview-player').pause();$('#region-audio-preview').pause(); });
  $('#review-form').addEventListener('submit', event => { event.preventDefault(); return startReviewRepair(); });

  async function startReviewRepair() {
    if (!mediaState.voiceVideo || reviewBusy) return;
    if (reviewMode === 'regenerate' && !reviewSelection) return;
    const name = `review-${Date.now()}`;
    if (reviewMode === 'replace' && !regionAudio) return;
    const region=readReviewRegion();
    if(reviewMode!=='regenerate'&&regionIssue(region)){updateReviewAction();return;}
    const payload = reviewMode !== 'regenerate'
      ? {operation:reviewMode === 'replace' ? 'replace-region' : 'mute-region', name, videoToken:mediaState.voiceVideo.token, audioToken:regionAudio?.token, muteStart:region.start, muteEnd:region.end, durationPolicy:region.fit}
      : {operation:'voice-candidates', name, videoToken:mediaState.voiceVideo.token, audioSource:'generate', originalStartMs:reviewSelection.startMs, originalEndMs:reviewSelection.endMs, sourceDisplayName:mediaState.voiceVideo.name, startPage:reviewSelection.number, endPage:reviewSelection.number,
        candidateCount:Number($('#voice-candidate-count').value), durationPolicy:$('#voice-duration-policy').value, overrideText:readOverrideText()};
    reviewResumeMs = reviewMode !== 'regenerate' ? Math.max(0, payload.muteStart * 1000 - 1000) : reviewSelection.startMs;
    pendingCandidateContext = {...payload};
    $("#review-candidates-host").classList.add("hidden");
    $("#review-saved").classList.add("hidden");
    reviewPlayer.pause();
    try { setEditBusy(true); await api.startEdit(payload); }
    catch (error) { setEditBusy(false); showToast(error.message, 'error'); }
  }

  // 확인 항목에서 바로 다시 읽히기. 마음에 들 때까지 몇 번이고 누르는 버튼이라
  // 한 번 쓰고 사라지지 않는다 — 후보가 별로면 그 자리에서 또 누르면 된다.
  function regenerateFinding(finding, page) {
    if (!page) { showToast('이 항목은 페이지 정보가 없어 재생성할 수 없습니다.', 'error'); return; }
    if (reviewBusy) { showToast('앞선 작업이 끝난 뒤에 다시 눌러 주세요.'); return; }
    if (reviewMode !== 'regenerate') setReviewMode('regenerate');
    selectReviewPage(page, voiceFindingReason(finding));
    seekReview(page.startMs / 1000);
    startReviewRepair();
  }

  // 몇 번을 다시 만들어도 같게 읽히는 자리가 있다. 이 버튼은 생성을 걸지 않고
  // 읽을 말을 적는 칸을 대본으로 채워 연다. 고쳐 적은 뒤 사람이 시작한다.
  function rewriteFinding(finding, page) {
    if (!page) { showToast('이 항목은 페이지 정보가 없어 재생성할 수 없습니다.', 'error'); return; }
    if (reviewBusy) { showToast('앞선 작업이 끝난 뒤에 다시 눌러 주세요.'); return; }
    if (reviewMode !== 'regenerate') setReviewMode('regenerate');
    selectReviewPage(page, voiceFindingReason(finding));
    seekReview(page.startMs / 1000);
    setOverrideText(readOverrideText() || page.text || '', { open: true });
    updateReviewAction();
    $('#voice-override-text').focus?.();
  }

  $('#voice-override-text').addEventListener('input', () => { updateOverrideState(); updateReviewAction(); });
  $('#voice-override-fill').addEventListener('click', () => {
    if (!reviewSelection) { showToast('먼저 수정할 페이지를 선택해 주세요.'); return; }
    setOverrideText(reviewSelection.text || '', { open: true });
    updateReviewAction();
  });
  $('#voice-override-clear').addEventListener('click', () => { setOverrideText(''); updateReviewAction(); });
  $('#review-candidate-original').addEventListener('click', () => {
    if (pendingCandidateContext) playReviewRange(pendingCandidateContext.originalStartMs / 1000, pendingCandidateContext.originalEndMs / 1000);
  });
  $('#review-continue').addEventListener('click', async () => {
    if (!mediaState.latestEditTarget) return;
    const resume = reviewResumeMs;
    if (!await openReview(mediaState.latestEditTarget)) return;
    seekReview(resume / 1000);
    $('#review-version').textContent = '수정본 검수 중 · 이전 버전 보관됨';
  });

  return {
    get reviewSelection() { return reviewSelection; },
    set reviewSelection(value) { reviewSelection = value; },
    get clearedFindings() { return clearedFindings; },
    get reviewBusy() { return reviewBusy; },
    set reviewBusy(value) { reviewBusy = value; },
    updateReviewAction,
    updateReviewPosition,
    get pendingCandidateContext() { return pendingCandidateContext; },
    set pendingCandidateContext(value) { pendingCandidateContext = value; },
    get pendingFixes() { return pendingFixes; },
    renderPendingFixes,
    openReview,
    renderCompleteVoiceFindings,
    get latestCompleteReview() { return latestCompleteReview; },
    set latestCompleteReview(value) { latestCompleteReview = value; },
    paintReviewFileName,
    get reviewPlayer() { return reviewPlayer; },
    setReviewVideo,
    queueSelectedCandidate,
    selectReviewPage,
    currentReviewPage,
    renderVoiceFindingRow,
    renderFindingGroup,
    renderFindings,
    readOverrideText,
    setOverrideText,
    savePendingFixes,
    visibleFindings,
    clearFinding,
    restoreClearedFindings,
  };
}
