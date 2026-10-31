export function createWorkspaceOperationTracker(onActiveChange = () => {}) {
  const owners = new Set();
  let disposed = false;

  const publish = () => {
    if (!disposed) onActiveChange(owners.size > 0);
  };

  return {
    acquire(label = "workspace-operation") {
      const owner = Symbol(label);
      if (disposed) return owner;
      owners.add(owner);
      publish();
      return owner;
    },
    release(owner) {
      if (disposed || !owners.delete(owner)) return false;
      publish();
      return true;
    },
    reset() {
      if (disposed) return;
      owners.clear();
      publish();
    },
    activeCount() {
      return owners.size;
    },
    activate() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      owners.clear();
    },
  };
}
