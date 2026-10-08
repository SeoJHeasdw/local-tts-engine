// 자막 모양의 이름·기본값. 화면 선택지·촬영 CLI·완성본 보고서가 모두 여기를 읽는다.
// 렌더러도 import하므로 Node 의존성을 두지 않는다. 실제 CSS는 main/capture/caption-style.mjs가 소유한다.
export const CAPTION_STYLES = Object.freeze({
  shadow: Object.freeze({ id: 'shadow', label: '그림자 · 어두운 화면용' }),
  box: Object.freeze({ id: 'box', label: '회색 박스 · 밝은 화면용' }),
});
// 기본은 이미 만든 영상과 같은 모양이다.
export const DEFAULT_CAPTION_STYLE = 'shadow';

/** 모르는 값은 기본으로 돌린다. 저장된 옛 설정이나 손으로 친 값이 촬영을 막지 않게 한다. */
export function captionStyleId(raw) {
  return Object.hasOwn(CAPTION_STYLES, raw) ? raw : DEFAULT_CAPTION_STYLE;
}

/** 명령줄은 오타를 기본으로 돌리지 않고 멈춘다 — 흰 영상에 그림자 자막이 조용히 구워지면 다시 찍어야 한다. */
export function requireCaptionStyle(raw) {
  if (!Object.hasOwn(CAPTION_STYLES, raw)) {
    throw new Error(`--caption-style은 ${Object.keys(CAPTION_STYLES).join(', ')} 중 하나여야 합니다.`);
  }
  return raw;
}
