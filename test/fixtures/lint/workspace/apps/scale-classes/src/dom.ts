export const WORDS = ["shadow", "blur", "leading-6"];

export function mount(el: HTMLElement) {
  el.className = "shadow";
  el.classList.add("backdrop-blur");
  el.innerHTML = `<div class="blur ${WORDS.length ? "leading-3" : ""}">x</div>`;
  el.title = "blur";
}
export const buttonProps = { className: "drop-shadow", title: "blur" };
