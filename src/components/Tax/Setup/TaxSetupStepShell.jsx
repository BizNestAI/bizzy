import React from "react";

export default function TaxSetupStepShell({ title, description, children, errors = {} }) {
  const errorMessages = Object.entries(errors).filter(([, message]) => message);
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-white">{title}</h2>
        {description ? <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/62">{description}</p> : null}
      </div>
      {errorMessages.length ? (
        <div role="alert" className="rounded-2xl border border-rose-300/22 bg-rose-400/[0.08] px-3 py-2 text-sm text-rose-50">
          <div className="font-semibold">Review these fields</div>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-rose-50/82">
            {errorMessages.map(([field, message]) => <li key={field}>{message}</li>)}
          </ul>
        </div>
      ) : null}
      {children}
    </section>
  );
}
