import { Accessor, Component, For, createSignal, onCleanup } from 'solid-js';

export type Toast = { id: number; title: string; message: string; image?: string };
type NewToast = Omit<Toast, 'id'>;

export type ToastEngine = {
  toasts: Accessor<Toast[]>;
  show: (toast: NewToast, duration?: number) => number;
  dismiss: (id: number) => void;
};

export const createToastEngine = (): ToastEngine => {
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const timers = new Map<number, number>();
  let nextId = 1;

  const dismiss = (id: number) => {
    const timer = timers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.delete(id);
    setToasts(current => current.filter(toast => toast.id !== id));
  };

  const show = (toast: NewToast, duration = 3000) => {
    const id = nextId++;
    setToasts(current => [...current, { ...toast, id }]);
    timers.set(id, window.setTimeout(() => dismiss(id), duration));
    return id;
  };

  onCleanup(() => {
    timers.forEach(timer => window.clearTimeout(timer));
    timers.clear();
  });

  return { toasts, show, dismiss };
};

export const ToastHost: Component<{ engine: ToastEngine }> = props => <div class="toast-stack" aria-live="polite">
  <For each={props.engine.toasts()}>{toast =>
    <button class="image-toast" type="button" onClick={() => props.engine.dismiss(toast.id)} aria-label={`Dismiss ${toast.message}`}>
      {toast.image && <img src={toast.image} alt="" />}
      <span><b>{toast.title}</b><small>{toast.message}</small></span>
      <i>×</i>
    </button>
  }</For>
</div>;
