(() => {
  const labels = {
    en: "Search or ask a question...",
    zh: "搜索或提问...",
  };

  const trackedSearchInputs = new WeakSet();

  function updateSearchQueryState(input) {
    const form = input.closest(".pagefind-ui__form");
    if (!form) return;

    form.dataset.hasQuery = input.value.trim() ? "true" : "false";
  }

  function updateSearchLabel() {
    const lang = document.documentElement.lang === "zh-CN" ? "zh" : "en";
    document.querySelectorAll("site-search .pagefind-ui__search-input").forEach((input) => {
      input.placeholder = labels[lang];
      input.setAttribute("aria-label", labels[lang]);
      updateSearchQueryState(input);

      if (trackedSearchInputs.has(input)) return;

      input.addEventListener("input", () => updateSearchQueryState(input));
      input.addEventListener("search", () => updateSearchQueryState(input));
      trackedSearchInputs.add(input);
    });
  }

  const trackedSidebarDetails = new WeakSet();
  const sidebarTimers = new WeakMap();

  function syncSidebarDetail(details) {
    details.dataset.expanded = details.open ? "true" : "false";
  }

  function finishSidebarAnimation(details, list, expanded) {
    list.style.transition = "";

    if (expanded) {
      list.style.height = "";
      list.style.opacity = "";
      list.style.marginTop = "";
      list.style.overflow = "";
    } else {
      details.open = false;
      details.dataset.expanded = "false";
      list.style.height = "0px";
      list.style.opacity = "0";
      list.style.marginTop = "0px";
      list.style.overflow = "hidden";
    }

    sidebarTimers.delete(details);
  }

  function animateSidebarDetail(details, expanded) {
    const list = details.querySelector(":scope > ul");
    if (!list) {
      details.open = expanded;
      syncSidebarDetail(details);
      return;
    }

    const previousTimer = sidebarTimers.get(details);
    if (previousTimer) window.clearTimeout(previousTimer);

    const duration = 180;
    const easing = "cubic-bezier(0.16, 1, 0.3, 1)";

    list.style.transition = "";
    list.style.overflow = "hidden";

    if (expanded) {
      details.open = true;
      details.dataset.expanded = "true";
      list.style.height = "0px";
      list.style.opacity = "0";
      list.style.marginTop = "0px";

      const targetHeight = `${list.scrollHeight}px`;
      window.requestAnimationFrame(() => {
        list.style.transition = `height ${duration}ms ${easing}, margin-top ${duration}ms ${easing}, opacity 120ms ease-out`;
        list.style.height = targetHeight;
        list.style.opacity = "1";
        list.style.marginTop = "0.32rem";
      });

      sidebarTimers.set(
        details,
        window.setTimeout(() => finishSidebarAnimation(details, list, true), duration + 40),
      );
      return;
    }

    details.dataset.expanded = "true";
    list.style.height = `${list.getBoundingClientRect().height || list.scrollHeight}px`;
    list.style.opacity = "1";
    list.style.marginTop = getComputedStyle(list).marginTop;

    window.requestAnimationFrame(() => {
      list.style.transition = `height ${duration}ms ${easing}, margin-top ${duration}ms ${easing}, opacity 120ms ease-out`;
      list.style.height = "0px";
      list.style.opacity = "0";
      list.style.marginTop = "0px";
    });

    sidebarTimers.set(
      details,
      window.setTimeout(() => finishSidebarAnimation(details, list, false), duration + 40),
    );
  }

  function setupSidebarDetails() {
    document.querySelectorAll(".sidebar-content details").forEach((details) => {
      if (!trackedSidebarDetails.has(details)) {
        details.addEventListener("toggle", () => syncSidebarDetail(details));

        trackedSidebarDetails.add(details);
      }

      syncSidebarDetail(details);
    });
  }

  document.addEventListener("DOMContentLoaded", updateSearchLabel);
  document.addEventListener("DOMContentLoaded", setupSidebarDetails);
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented) return;
      if (!(event.target instanceof Element)) return;

      const summary = event.target.closest("summary");
      const details = summary?.parentElement;
      if (!details?.matches(".sidebar-content details")) return;

      event.preventDefault();
      const expanded =
        details.dataset.expanded === undefined
          ? !details.open
          : details.dataset.expanded !== "true";
      animateSidebarDetail(details, expanded);
    },
    true,
  );

  new MutationObserver(() => {
    updateSearchLabel();
    setupSidebarDetails();
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open", "lang"],
  });
})();
