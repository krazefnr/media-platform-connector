/**
 * Just enough DOM for mountMediaDashboard and the sales screen to run under
 * node:test: elements, text, attributes, listeners and layout boxes the test
 * sets by hand.
 */

type Listener = (event: unknown) => void;
type Box = { top: number; left: number; width: number; height: number };

export class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  listeners = new Map<string, Listener[]>();
  hidden = false;
  className = "";
  id = "";
  nonce = "";
  title = "";
  src = "";
  disabled = false;
  contentWindow: unknown = null;
  box: Box = { top: 0, left: 0, width: 0, height: 0 };
  clientTop = 0;
  clientLeft = 0;
  private ownText = "";

  constructor(readonly tagName: string) {}

  get clientWidth() {
    return this.box.width;
  }
  get clientHeight() {
    return this.box.height;
  }
  get offsetWidth() {
    return this.box.width;
  }
  getBoundingClientRect() {
    return { ...this.box, right: this.box.left + this.box.width, bottom: this.box.top + this.box.height };
  }

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...add: string[]) => {
        this.className = [...new Set([...names(), ...add])].join(" ");
      },
      remove: (...remove: string[]) => {
        this.className = names().filter((n) => !remove.includes(n)).join(" ");
      },
      contains: (name: string) => names().includes(name),
    };
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }

  append(...nodes: Array<FakeElement | string>) {
    for (const node of nodes) this.appendChild(typeof node === "string" ? textNode(node) : node);
  }
  appendChild(node: FakeElement) {
    node.remove();
    node.parent = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node: FakeElement, ref: FakeElement | null) {
    node.remove();
    node.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(i < 0 ? this.children.length : i, 0, node);
    return node;
  }
  replaceChildren(...nodes: Array<FakeElement | string>) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.ownText = "";
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  get isConnected(): boolean {
    let node: FakeElement = this;
    while (node.parent) node = node.parent;
    return node === fakeDocument.documentElement;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.replaceChildren();
    this.ownText = value;
  }

  find(predicate: (el: FakeElement) => boolean): FakeElement | null {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const hit = child.find(predicate);
      if (hit) return hit;
    }
    return null;
  }
}

function textNode(text: string) {
  const node = new FakeElement("#text");
  node.textContent = text;
  return node;
}

export type Posted = { message: unknown; targetOrigin: string };

const documentElement = new FakeElement("html");
const head = new FakeElement("head");
const body = new FakeElement("body");
documentElement.append(head, body);

export const fakeDocument = {
  documentElement,
  head,
  body,
  createElement(tag: string) {
    const el = new FakeElement(tag);
    if (tag === "iframe") {
      const posted: Posted[] = [];
      el.contentWindow = { posted, postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }) };
    }
    return el;
  },
  createElementNS(_ns: string, tag: string) {
    return new FakeElement(tag);
  },
  createTextNode: textNode,
  getElementById(id: string) {
    return documentElement.find((el) => el.id === id);
  },
};

const windowListeners = new Map<string, Listener[]>();

export const fakeWindow = {
  location: new URL("https://shop.example/admin/media"),
  addEventListener(type: string, listener: Listener) {
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
  },
  removeEventListener(type: string, listener: Listener) {
    windowListeners.set(type, (windowListeners.get(type) ?? []).filter((l) => l !== listener));
  },
  confirm: () => true,
  dispatch(type: string, event: unknown) {
    for (const listener of windowListeners.get(type) ?? []) listener(event);
  },
  listenerCount(type: string) {
    return (windowListeners.get(type) ?? []).length;
  },
};

class FakeMutationObserver {
  observe() {}
  disconnect() {}
}

/** Installs the fake globals and a fetch that answers with `respond`; returns a function that restores the originals. */
export function installDom(respond: (url: string, init?: RequestInit) => Response): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, MutationObserver: g.MutationObserver, fetch: g.fetch };
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.MutationObserver = FakeMutationObserver;
  g.fetch = async (url: string, init?: RequestInit) => respond(String(url), init);
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
