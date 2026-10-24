/**
 * Historique annuler / rétablir : on garde des instantanés JSON de l'état
 * (les images sont référencées par identifiant, jamais copiées).
 */
export class History {
  constructor(limit = 80) {
    this.limit = limit;
    this.stack = [];
    this.index = -1;
    this.listeners = new Set();
  }

  reset(state) {
    this.stack = [JSON.stringify(state)];
    this.index = 0;
    this._emit();
  }

  /** Enregistre l'état s'il a changé depuis le dernier instantané. */
  commit(state) {
    const s = JSON.stringify(state);
    if (s === this.stack[this.index]) return false;
    this.stack.length = this.index + 1;
    this.stack.push(s);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    this._emit();
    return true;
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.stack.length - 1;
  }

  undo() {
    if (!this.canUndo) return null;
    this.index--;
    this._emit();
    return JSON.parse(this.stack[this.index]);
  }

  redo() {
    if (!this.canRedo) return null;
    this.index++;
    this._emit();
    return JSON.parse(this.stack[this.index]);
  }

  /** Identifiants d'images encore utilisés dans l'historique. */
  usedImageIds() {
    const ids = new Set();
    for (const s of this.stack) {
      for (const m of s.matchAll(/"imageId":"([^"]+)"/g)) ids.add(m[1]);
    }
    return ids;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn();
  }
}

// GROGNON
