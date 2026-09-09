export function lessonCatalogFromPresets(pages = [], presets = {}) {
  const findPage = (chapter, slideId) => pages.find((page) => (
    String(page?.slideId || "") === String(slideId || "")
    && (!chapter || String(page?.chapter || "") === String(chapter))
  ));
  return Object.entries(presets || {})
    .filter(([id]) => /^ch\d{2}(?:-l\d{2}(?:-end)?)?$/.test(id))
    .map(([id, preset]) => {
      const start = findPage(preset.startChapter, preset.startSlide);
      const end = findPage(preset.endChapter || preset.startChapter, preset.endSlide || preset.startSlide);
      if (!start || !end || Number(end.page) < Number(start.page)) return null;
      const selected = pages.filter((page) => Number(page.page) >= Number(start.page) && Number(page.page) <= Number(end.page));
      return {
        id,
        title: String(preset.title || id),
        chapter: String(start.chapter || ""),
        startPage: Number(start.page),
        endPage: Number(end.page),
        pageCount: selected.length,
        stepCount: selected.reduce((total, page) => total + Math.max(0, Number(page.stepCount || 0)), 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startPage - b.startPage || a.endPage - b.endPage);
}

/**
 * deck 레슨 파일에서 뽑아낸 레슨 목록을 정본으로 쓰고, 아직 레슨으로
 * 쪼개지 않은 챕터만 narration.config.json 의 preset 으로 채운다.
 * 한 챕터를 두 곳에서 동시에 정의하면 목록에 같은 구간이 두 번 나온다.
 */
export function combineLessonCatalogs(deckLessons = [], presetLessons = []) {
  const covered = new Set(deckLessons.map((lesson) => lesson.chapter));
  return [...deckLessons, ...presetLessons.filter((lesson) => !covered.has(lesson.chapter))]
    .sort((a, b) => a.startPage - b.startPage || a.endPage - b.endPage);
}
