(() => {
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) return;

  const cta = document.querySelector(".cta");
  if (!cta) return;

  cta.addEventListener("click", () => {
    cta.classList.add("is-pressed");
    window.setTimeout(() => cta.classList.remove("is-pressed"), 280);
  });
})();
