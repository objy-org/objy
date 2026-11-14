import { escapeHTML, icon } from "./markup.js";

// One dialog owns submission, focus, and cleanup, including when replaced.
export class Dialog {
  constructor(onChange) {
    this.root = document.querySelector("#modal-root");
    this.shell = document.querySelector("#shell");
    this.onChange = onChange;
    this.busy = false;
    this.root.addEventListener("click", (event) => {
      if (event.target.matches(".modal-overlay") || event.target.closest('[data-action="close-modal"]'))
        this.close();
    });
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
      if (event.key !== "Tab") return;
      const controls = [...this.root.querySelectorAll("button,input,select,textarea")]
        .filter((control) => !control.disabled && control.getClientRects().length);
      const edge = event.shiftKey ? controls[0] : controls.at(-1);
      if (document.activeElement === edge) {
        event.preventDefault();
        (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
    });
  }

  show(title, body, onSubmit, { className = "", onClose } = {}) {
    this.dispose?.();
    this.dispose = onClose;
    if (!this.root.firstChild)
      this.returnFocus = document.activeElement?.shadowRoot?.activeElement || document.activeElement;
    this.shell.inert = true;
    this.root.innerHTML = `<div class="modal-overlay"><div class="modal ${className}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">${escapeHTML(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="Close dialog">${icon("close", 1.5)}</button></div>${body}<p class="modal-error" role="alert" hidden></p></div></div>`;
    const modal = this.root.querySelector(".modal"), form = modal.querySelector("form");
    if (form && onSubmit) form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("[type=submit]"), errorBox = modal.querySelector(".modal-error");
      if (this.busy || button.disabled) return;
      button.disabled = this.busy = true;
      errorBox.hidden = true;
      this.onChange();
      try { await onSubmit(new FormData(form)); }
      catch (error) {
        errorBox.textContent = error.message;
        errorBox.hidden = false;
        if (error.writeMayHaveSucceeded) {
          button.dataset.uncertain = "true";
          button.textContent = "Inspect data first";
        }
      } finally {
        this.busy = false;
        button.disabled = button.dataset.uncertain === "true";
        this.onChange();
      }
    });
    (modal.querySelector("input,select,textarea") || modal.querySelector("button"))?.focus();
    return modal;
  }

  close(force = false) {
    if ((this.busy && !force) || !this.root.firstChild) return;
    this.dispose?.();
    this.dispose = null;
    this.root.replaceChildren();
    this.shell.inert = false;
    (this.returnFocus?.isConnected ? this.returnFocus : document.querySelector("#connection-control"))?.focus();
  }
}
