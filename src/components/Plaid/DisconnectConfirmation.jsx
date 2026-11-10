import React from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
export default function DisconnectConfirmation({ name, busy, onCancel, onConfirm }) {
  return <Dialog open onClose={() => { if (!busy) onCancel(); }} className="relative z-[2147482000]">
    <div className="fixed inset-0 bg-black/70" aria-hidden="true" />
    <div className="fixed inset-0 flex items-center justify-center overflow-y-auto p-4">
      <DialogPanel className="w-full max-w-md rounded-xl border border-white/15 bg-[#111713] p-5 text-sm text-white/75 shadow-xl">
        <DialogTitle className="break-words font-semibold text-white">Disconnect {name}?</DialogTitle>
        <p className="mt-3">New synchronization will stop. Historical Bizzi transactions and categorizations remain saved.</p>
        <p className="mt-2">For a reconnect-required connection, use Reconnect instead. Disconnecting is not the normal repair.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <button type="button" data-autofocus disabled={busy} onClick={onCancel} className="rounded px-3 py-2 text-white focus-visible:outline">Cancel</button>
          <button type="button" disabled={busy} onClick={onConfirm} className="rounded border border-rose-300/25 px-3 py-2 text-rose-200 focus-visible:outline">{busy ? 'Disconnecting…' : 'Confirm disconnect'}</button>
        </div>
      </DialogPanel>
    </div>
  </Dialog>;
}
