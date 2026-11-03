// unlocal console. No framework: one render per view, DOM built with h() (never innerHTML).

const root = document.getElementById("root");
const dialog = document.getElementById("plan");
const usd = (n) => `$${Number(n).toFixed(2)}`;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(json.error.message);
    err.code = json.error.code;
    err.hint = json.error.hint;
    throw err;
  }
  return json;
}

const errorText = (err) => [err.message, err.hint].filter(Boolean).join(". ");

/** A one-field form whose button shows progress and whose errors appear beneath it. */
function inlineForm({ type = "text", value = "", placeholder, label, primary, onsubmit, attrs = {} }) {
  const input = h("input", { type, value, placeholder, "aria-label": placeholder ?? label, ...attrs });
  const button = h("button", { class: primary ? "primary" : "" }, label);
  const error = h("div", { class: "err" });
  const form = h("form", {
    class: "row",
    onsubmit: async (e) => {
      e.preventDefault();
      button.disabled = true;
      error.textContent = "";
      try {
        await onsubmit(input.value);
      } catch (err) {
        error.textContent = errorText(err);
      } finally {
        button.disabled = false;
      }
    },
  }, input, button);
  return h("div", {}, form, error);
}

// ── Login ──────────────────────────────────────────────────────────────────
// Two steps, email then password, so the screen only ever asks one thing.
function renderLogin(setupRequired, presetEmail = "") {
  const title = setupRequired ? "Create your unlocal account" : "Log in to unlocal";
  const head = [h("img", { class: "logo", src: "/favicon.svg", alt: "" }), h("h1", {}, title)];

  const email = h("input", { type: "email", value: presetEmail, placeholder: "Email address", autocomplete: "username", required: true });
  root.replaceChildren(h("form", {
    class: "login",
    onsubmit: (e) => { e.preventDefault(); passwordStep(email.value.trim()); },
  }, ...head, email, h("button", { class: "primary" }, "Continue with email")));
  email.focus();

  function passwordStep(address) {
    const password = h("input", {
      type: "password", placeholder: setupRequired ? "New password, 10+ characters" : "Password",
      required: true, minlength: "10", autocomplete: setupRequired ? "new-password" : "current-password",
    });
    // Hidden username field so password managers save the pair.
    const user = h("input", { type: "email", value: address, autocomplete: "username", hidden: true, tabindex: "-1" });
    const button = h("button", { class: "primary" }, setupRequired ? "Create account" : "Log in");
    const error = h("div", { class: "err", role: "alert" });
    root.replaceChildren(h("form", {
      class: "login",
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        error.textContent = "";
        try {
          await api("POST", setupRequired ? "/api/setup" : "/api/login", { email: address, password: password.value });
          await renderApp();
        } catch (err) {
          error.textContent = errorText(err);
          button.disabled = false;
          password.select();
        }
      },
    }, ...head,
      h("button", { type: "button", class: "who", onclick: () => renderLogin(setupRequired, address) }, address),
      user, password, button, error));
    password.focus();
  }
}

// ── Overview ───────────────────────────────────────────────────────────────
async function renderApp() {
  let data;
  try {
    data = await api("GET", "/api/overview");
  } catch (err) {
    if (err.code === "UNAUTHENTICATED") return boot();
    throw err;
  }
  const testMode = data.payments === "test";

  const balance = h("div", { class: "stat" },
    h("div", { class: "label" }, "Balance"),
    h("div", { class: "value num" }, usd(data.balanceUsd)),
    inlineForm({
      type: "number", value: "20", label: testMode ? "Add test credit" : "Add funds",
      attrs: { min: "5", max: "1000", step: "1", inputmode: "decimal" },
      onsubmit: async (v) => {
        const r = await api("POST", "/api/funds", { usd: Number(v) });
        if (r.checkoutUrl) location.href = r.checkoutUrl;
        else await renderApp();
      },
    }),
  );

  const cap = h("div", { class: "stat" },
    h("div", { class: "label" }, "Monthly cap"),
    h("div", { class: "value num" }, data.monthlyCapUsd === null ? "None" : usd(data.monthlyCapUsd)),
    inlineForm({
      type: "number", value: data.monthlyCapUsd ?? "", placeholder: "10",
      label: data.monthlyCapUsd === null ? "Set" : "Change",
      attrs: { min: "1", step: "1", inputmode: "decimal" },
      onsubmit: async (v) => {
        await api("POST", "/api/cap", { usd: Number(v) });
        await renderApp();
      },
    }),
  );

  const projects = h("div", { class: "list" },
    data.projects.map((p) => p.error
      ? h("div", { class: "item" }, h("div", { class: "main" }, h("div", { class: "name" }, p.dir), h("div", { class: "err" }, p.error)))
      : h("div", { class: "item" },
          h("div", { class: "main" },
            h("div", { class: "name" }, p.project),
            h("div", { class: "muted" },
              p.url && !p.live ? "sim" : p.cloud, " · ",
              p.url ? h("a", { href: p.url, target: "_blank", rel: "noopener" }, p.url.replace(/^https:\/\//, "")) : "not deployed"),
          ),
          h("div", { class: "num muted" }, `${usd(p.monthlyUsd)}/mo`),
          h("button", { class: p.pending ? "primary" : "", disabled: !p.pending || p.deploying, onclick: () => openDeploy(p, data) },
            p.deploying ? "Deploying…" : p.pending ? "Deploy" : "Up to date"),
        )),
    inlineForm({
      placeholder: "Project folder, e.g. ~/code/site", label: "Add project",
      onsubmit: async (v) => {
        await api("POST", "/api/projects", { dir: v });
        await renderApp();
      },
    }),
  );

  const activity = data.transactions.length
    ? [h("h2", {}, "Activity"), h("div", { class: "list" }, data.transactions.map((t) => h("div", { class: "item" },
        h("div", { class: "main muted num" }, new Date(t.at).toLocaleString()),
        h("div", {}, t.kind === "credit" ? "Test credit" : "Added funds"),
        h("div", { class: "num ok" }, `+${usd(t.amountUsd)}`),
      )))]
    : [];

  root.replaceChildren(h("div", { class: "wrap" },
    h("header", {},
      h("div", { class: "mark" }, "unlocal"),
      data.login && h("span", { class: "muted" }, data.user.email),
      data.login && h("button", { class: "link", onclick: async () => { await api("POST", "/api/logout"); boot(); } }, "Log out"),
    ),
    h("section", { class: "stats" }, balance, cap),
    h("h2", {}, "Projects"),
    projects,
    ...activity,
  ));
}

// ── Deploy ─────────────────────────────────────────────────────────────────
const SYMBOL = { create: "+", update: "~", replace: "±", delete: "-" };

/** Why this plan can't go live, in the words a person needs, or null. */
function blocker(plan) {
  if (!plan.hasChanges) return "Already up to date.";
  if (!plan.budget.withinBudget) return `Over this project's ${usd(plan.budget.limitUsd)}/mo budget.`;
  if (!plan.cap) return "Set a monthly cap first.";
  if (!plan.cap.withinCap) return `All projects would cost ${usd(plan.cap.projectedUsd)}/mo, over your ${usd(plan.cap.limitUsd)} cap.`;
  if (!plan.cap.funded) return `Add funds: a month costs ${usd(plan.cap.projectedUsd)}, balance is ${usd(plan.cap.balanceUsd)}.`;
  if (plan.destructive) return "This deletes data. Use the CLI with --allow-data-loss.";
  return null;
}

async function openDeploy(project, overview) {
  dialog.replaceChildren(h("h3", {}, project.project), h("div", { class: "muted" }, "Planning…"));
  dialog.showModal();
  let plan;
  try {
    plan = (await api("POST", "/api/plan", { dir: project.dir })).plan;
  } catch (err) {
    return dialog.replaceChildren(h("h3", {}, project.project), h("div", { class: "err" }, errorText(err)), closeRow("Close"));
  }

  const lines = plan.actions
    .filter((a) => a.kind !== "noop")
    .map((a) => `${SYMBOL[a.kind]} ${a.kind} ${a.name} (${a.type})  ${usd(a.monthlyUsdAfter)}/mo${a.changes.length ? `  ${a.changes.join(", ")}` : ""}`);
  const summary = plan.cap
    ? `${usd(plan.cost.projectedMonthlyUsd)}/mo · ${usd(plan.cap.projectedUsd)} of ${usd(plan.cap.limitUsd)} cap · balance ${usd(plan.cap.balanceUsd)}`
    : `${usd(plan.cost.projectedMonthlyUsd)}/mo`;
  const reason = blocker(plan);
  const status = h("div", { class: reason ? "err" : "" }, reason ?? "");
  const deploy = h("button", { class: "primary", disabled: Boolean(reason) }, "Deploy");
  const cancel = h("button", { onclick: () => dialog.close() }, "Cancel");

  deploy.addEventListener("click", async () => {
    deploy.disabled = true;
    cancel.disabled = true;
    deploy.textContent = "Deploying…";
    status.className = "muted";
    status.textContent = "Creating resources. A new site takes a few minutes to start serving.";
    try {
      const r = await api("POST", "/api/deploy", { dir: project.dir, planId: plan.id });
      status.className = "";
      status.replaceChildren(...(r.url ? ["Live at ", h("a", { href: r.url, target: "_blank", rel: "noopener" }, r.url)] : ["Done."]));
      deploy.remove();
      cancel.textContent = "Done";
      cancel.disabled = false;
      cancel.onclick = () => { dialog.close(); renderApp(); };
    } catch (err) {
      status.className = "err";
      status.textContent = errorText(err);
      deploy.textContent = "Deploy";
      cancel.disabled = false;
    }
  });

  dialog.replaceChildren(
    h("h3", {}, project.project),
    h("pre", {}, [...lines, "", summary].join("\n")),
    status,
    h("div", { class: "actions" }, cancel, deploy),
  );
}

function closeRow(label) {
  return h("div", { class: "actions" }, h("button", { onclick: () => dialog.close() }, label));
}

async function boot() {
  const s = await api("GET", "/api/session");
  if (s.user || !s.login) await renderApp();
  else renderLogin(s.setupRequired);
}

boot();
