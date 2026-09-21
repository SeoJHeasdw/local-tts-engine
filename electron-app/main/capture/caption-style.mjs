// 강의와 앱 데모가 함께 쓰는 자막 모양. 1920×1080 무대에 그리고 결과 크기로 늘린다.
// 강의는 덱 화면 위에 이 모양으로 겹쳐 찍고(capture/deck-page.mjs), 앱 데모는 이 모양을
// 투명 그림으로 떠서 완성본에 겹친다(editing/demo-captions.mjs). 둘이 같은 자막으로 보인다.
export function captionOverlayCss(width, height) {
  return `
      #narration-caption-stage {
        position: fixed; left: 0; top: 0; width: 1920px; height: 1080px;
        transform: scale(${width / 1920}, ${height / 1080});
        transform-origin: top left; pointer-events: none; z-index: 2147483647;
      }
      #narration-caption-overlay {
        position: absolute;
        z-index: 2147483647;
        left: 50%;
        bottom: 72px;
        width: max-content;
        max-width: 1480px;
        transform: translateX(-50%) translateY(6px);
        box-sizing: border-box;
        padding: 0;
        border: 0;
        background: transparent;
        color: #fff;
        font-family: Pretendard, "Apple SD Gothic Neo", sans-serif;
        font-size: 34px;
        font-weight: 700;
        line-height: 1.42;
        letter-spacing: -0.025em;
        text-align: center;
        white-space: pre-line;
        text-wrap: balance;
        -webkit-text-stroke: 0.45px rgba(0, 0, 0, 0.92);
        text-shadow:
          0 2px 3px rgba(0, 0, 0, 0.96),
          0 0 10px rgba(0, 0, 0, 0.82),
          0 0 22px rgba(0, 0, 0, 0.5);
        opacity: 0;
        transition: opacity 100ms linear, transform 100ms ease-out;
        pointer-events: none;
      }
      #narration-caption-overlay[data-visible="true"] {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
  `;
}
