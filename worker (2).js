/* ============================================================
   lembrete-academy — Worker da Cloudflare
   Manda ao Jonas, por WhatsApp (CallMeBot), dois resumos por dia
   a partir do sistema da Academy (Supabase, tabela academy_data):
     • 08h00 (Lisboa) — o que tem de ser feito hoje
     • 20h00 (Lisboa) — fecho do dia: o que ficou feito, o que falta, amanhã
   Segredos a criar no Worker (Settings → Variables and Secrets):
     CALLMEBOT_PHONE   o número do Jonas com indicativo, ex. +351912345678
     CALLMEBOT_APIKEY  a chave do CallMeBot (a mesma do lembrete-hub)
     TEST_KEY          uma palavra-passe qualquer, só para testar no browser
   Opcionais: SUPA_URL, SUPA_KEY (se não existirem, usa os do sistema)
============================================================ */

const TZ = "Europe/Lisbon";
const HORA_MANHA = 8;
const HORA_NOITE = 20;
const SUPA_URL_PADRAO = "https://lluvisdkuuqxnaahuzuk.supabase.co";
const SUPA_KEY_PADRAO =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsdXZpc2RrdXVxeG5hYWh1enVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzOTQ0ODIsImV4cCI6MjA5Nzk3MDQ4Mn0.bxus8-oaNG8IwTdBU2ffUbCD44w8Bz1AsUCqCMPrpWI";
const MAX_ITENS = 5; // máximo de linhas por secção; o resto aparece como "+N"
const MAX_MSG = 900; // tamanho máximo de cada mensagem de WhatsApp

/* ---------- datas (sempre na hora de Lisboa) ---------- */
function agoraLisboa(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return { iso: `${g("year")}-${g("month")}-${g("day")}`, hora: Number(g("hour")) % 24 };
}
const addDias = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const diasAte = (iso, hoje) =>
  iso ? Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(hoje + "T00:00:00Z")) / 864e5) : null;
const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const fmtData = (iso) => {
  const d = new Date(iso + "T12:00:00Z");
  return `${DIAS[d.getUTCDay()]}, ${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
};
const quando = (iso, hoje) => {
  const d = diasAte(iso, hoje);
  return d === 0 ? "hoje" : d === 1 ? "amanhã" : d === -1 ? "ontem" : d < 0 ? `há ${-d} dias` : fmtData(iso);
};
const nTel = (t) => String(t || "").replace(/\D/g, "").slice(-9);
const primeiroNome = (n) => (n || "").trim().split(/\s+/)[0] || "";
const eur = (n) => `${Math.round(Number(n) || 0).toLocaleString("pt-PT")} €`;

/* ---------- dados do sistema ---------- */
async function lerSistema(env) {
  const url = (env.SUPA_URL || SUPA_URL_PADRAO) + "/rest/v1/academy_data?id=eq.main&select=data";
  const key = env.SUPA_KEY || SUPA_KEY_PADRAO;
  const r = await fetch(url, { headers: { apikey: key, Authorization: "Bearer " + key } });
  if (!r.ok) throw new Error("Supabase " + r.status);
  const rows = await r.json();
  if (!rows.length || !rows[0].data) throw new Error("sem dados na linha 'main'");
  return rows[0].data;
}

/* ---------- aulas ao vivo (mesma lógica do separador Acompanhamento) ---------- */
function cfgAcomp(data) {
  const produtos = data.produtosAcademy || [];
  const achar = (txt) =>
    (
      produtos.find((p) => p.modalidade !== "Online" && (p.nome || "").toLowerCase().includes(txt)) ||
      produtos.find((p) => (p.nome || "").toLowerCase().includes(txt)) ||
      {}
    ).id || "";
  const c = (data.acompAulas && data.acompAulas.config) || {};
  return {
    primeiraAula: c.primeiraAula || "",
    primeiraAulaB: c.primeiraAulaB || "",
    hora: c.hora || "21:00",
    produtoA: c.produtoA || achar("manicure"),
    produtoB: c.produtoB || achar("molde"),
  };
}
function serieQuinzenal(inicio, produtoId, de, ate) {
  if (!inicio || !produtoId) return [];
  const out = [];
  for (let i = -300; i < 300; i++) {
    const d = addDias(inicio, i * 14);
    if (d >= de && d <= ate) out.push({ data: d, produtoId });
  }
  return out;
}
function aulasAoVivo(data, de, ate) {
  const cfg = cfgAcomp(data);
  if (!cfg.primeiraAula) return [];
  const inicioB = cfg.primeiraAulaB || addDias(cfg.primeiraAula, 7);
  const nome = (id) => ((data.produtosAcademy || []).find((p) => p.id === id) || {}).nome || "Aula ao vivo";
  return [
    ...serieQuinzenal(cfg.primeiraAula, cfg.produtoA, de, ate),
    ...serieQuinzenal(inicioB, cfg.produtoB, de, ate),
  ]
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((a) => ({ ...a, nome: nome(a.produtoId), hora: cfg.hora }));
}

/* ---------- blocos de informação ---------- */
const lista = (itens, max = MAX_ITENS) =>
  itens.length > max ? [...itens.slice(0, max), `+${itens.length - max} no sistema`] : itens;
const turmasAtivas = (data) => (data.cursos || []).filter((c) => c.status !== "Cancelado");

function blocoTurmas(data, hoje, ate, titulo) {
  const out = [];
  turmasAtivas(data)
    .filter((c) => c.dataInicio && c.dataInicio >= hoje && c.dataInicio <= ate)
    .sort((a, b) => a.dataInicio.localeCompare(b.dataInicio))
    .forEach((c) => {
      const al = c.alunos || [];
      const pagas = al.filter((a) => a.pago || a.acaoSocial).length;
      let l = `• ${quando(c.dataInicio, hoje)} · ${c.nome}${c.horario ? ` · ${c.horario}` : ""} · ${al.length} aluna${al.length === 1 ? "" : "s"} (${pagas} paga${pagas === 1 ? "" : "s"})`;
      if (al.length < 2 && diasAte(c.dataInicio, hoje) <= 7) l += " ⚠️ abaixo do mínimo de 2";
      else if (al.length === 2) l += " (mínimo cumprido, ideal 3)";
      out.push(l);
    });
  return out.length ? { titulo, linhas: lista(out) } : null;
}

function blocoAulas(data, de, ate, hoje, titulo) {
  const out = aulasAoVivo(data, de, ate).map(
    (a) => `• ${quando(a.data, hoje)} às ${a.hora} · ${a.nome}`
  );
  return out.length ? { titulo, linhas: out } : null;
}

function blocoMensagemPosAula(data, hoje) {
  const ontem = aulasAoVivo(data, addDias(hoje, -1), addDias(hoje, -1));
  if (!ontem.length) return null;
  return {
    titulo: "💬 Mensagem pós-aula ao vivo",
    linhas: ontem.map(
      (a) => `• Ontem houve aula (${a.nome}): mandar mensagem às alunas e perguntar às que faltaram se está tudo bem`
    ),
  };
}

function blocoTarefasEquipa(data, hoje, ate, titulo, soAtrasadasEHoje) {
  const todas = (data.tasks || []).filter((t) => !t.done);
  const sel = todas
    .filter((t) => t.due && (soAtrasadasEHoje ? t.due <= hoje : t.due <= ate))
    .sort((a, b) => a.due.localeCompare(b.due));
  if (!sel.length) return null;
  const linhas = sel.map(
    (t) => `• ${t.title}${t.assignee ? ` — ${primeiroNome(t.assignee)}` : ""} (${quando(t.due, hoje)})`
  );
  return { titulo, linhas: lista(linhas) };
}

function nomePorTelefone(data, tel) {
  const n = nTel(tel);
  const lead = (data.sales?.leads || []).find((l) => nTel(l.phone) === n);
  if (lead) return lead.name;
  const crm = (data.crm?.contacts || []).find((c) => nTel(c.phone) === n);
  if (crm) return crm.nome;
  for (const c of data.cursos || []) {
    const a = (c.alunos || []).find((x) => nTel(x.phone) === n);
    if (a) return a.nome;
  }
  const v = (data.vendasOnline || []).find((x) => nTel(x.phone) === n);
  return v ? v.nome : tel;
}

function blocoTarefasAlunas(data, hoje, janela) {
  const out = [];
  Object.entries(data.fichas || {}).forEach(([tel, f]) =>
    (f.tarefas || []).forEach((t) => {
      if (t.done || !t.prazo) return;
      const d = diasAte(t.prazo, hoje);
      if (d <= janela) out.push({ d, txt: `• ${primeiroNome(nomePorTelefone(data, tel))}: ${t.titulo || t.title || t.texto || "tarefa"} (${quando(t.prazo, hoje)})` });
    })
  );
  out.sort((a, b) => a.d - b.d);
  return out.length ? { titulo: "📋 Tarefas das alunas", linhas: lista(out.map((x) => x.txt)) } : null;
}

function blocoFollowUps(data, hoje, ate, titulo) {
  const fora = ["perdido", "inativo", "concluído", "concluido"];
  const sel = (data.crm?.contacts || [])
    .filter((c) => c.proximoContacto && c.proximoContacto <= ate && !fora.includes((c.status || "").toLowerCase()))
    .sort((a, b) => a.proximoContacto.localeCompare(b.proximoContacto));
  if (!sel.length) return null;
  return {
    titulo,
    linhas: lista(sel.map((c) => `• ${c.nome}${c.curso ? ` (${c.curso})` : ""} — ${quando(c.proximoContacto, hoje)}`)),
  };
}

function blocoLeads(data) {
  const leads = (data.sales?.leads || []).filter((l) => !["Inscrito", "Em turma", "Perdido"].includes(l.stage));
  if (!leads.length) return null;
  const porEtapa = {};
  leads.forEach((l) => (porEtapa[l.stage] = (porEtapa[l.stage] || 0) + 1));
  const linhas = Object.entries(porEtapa).map(([e, n]) => `• ${e}: ${n}`);
  const novos = leads.filter((l) => l.stage === "Lead").map((l) => primeiroNome(l.name));
  if (novos.length) linhas.push(`• Por abordar: ${lista(novos, 6).join(", ")}`);
  return { titulo: "🎯 Leads em aberto", linhas };
}

function blocoPagamentos(data, hoje) {
  const limite = addDias(hoje, -90);
  const devidos = [];
  turmasAtivas(data)
    .filter((c) => (c.dataInicio || "") >= limite)
    .forEach((c) =>
      (c.alunos || []).forEach((a) => {
        if (!a.pago && !a.acaoSocial) devidos.push({ nome: primeiroNome(a.nome), curso: c.nome, valor: Number(a.preco ?? c.preco) || 0, data: c.dataInicio });
      })
    );
  (data.vendasOnline || []).forEach((v) => {
    if (!v.pago && v.data >= limite) devidos.push({ nome: primeiroNome(v.nome), curso: "online", valor: Number(v.valor ?? v.preco) || 0, data: v.data });
  });
  if (!devidos.length) return null;
  devidos.sort((a, b) => (a.data || "").localeCompare(b.data || ""));
  const total = devidos.reduce((s, x) => s + x.valor, 0);
  const linhas = lista(devidos.map((x) => `• ${x.nome} — ${x.curso}${x.valor ? ` (${eur(x.valor)})` : ""}`));
  linhas.unshift(`${devidos.length} por receber${total ? ` · ${eur(total)}` : ""}`);
  return { titulo: "💶 Pagamentos por receber", linhas };
}

function blocoRecuperar(data) {
  const out = [];
  turmasAtivas(data).forEach((c) =>
    (c.alunos || []).forEach((a) => {
      if (!a.acaoSocial && c.dossie?.avaliacao?.[a.id]?.faltou === true) out.push(`• ${primeiroNome(a.nome)} — faltou a ${c.nome}`);
    })
  );
  return out.length ? { titulo: "🔁 Alunas a recuperar (faltaram)", linhas: lista(out) } : null;
}

const MARCOS = [["d30", "30 dias", (b) => addDias(b, 30)], ["d90", "90 dias", (b) => addDias(b, 90)], ["m6", "6 meses", (b) => { const d = new Date(b + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 6); return d.toISOString().slice(0, 10); }]];
function checkinsEmFalta(data, hoje) {
  const limite = addDias(hoje, -60);
  const out = [];
  turmasAtivas(data).forEach((c) => {
    const base = c.dataFim || c.dataInicio;
    if (!base) return;
    const ac = c.dossie?.acomp || {};
    (c.alunos || []).forEach((a) => {
      if (c.dossie?.avaliacao?.[a.id]?.faltou === true) return;
      const x = ac[a.id] || {};
      MARCOS.forEach(([k, rot, f]) => {
        const d = f(base);
        if (d <= hoje && d >= limite && !x[k] && !x[k + "Env"]) out.push({ nome: primeiroNome(a.nome), rot, d });
      });
    });
  });
  return out.sort((a, b) => a.d.localeCompare(b.d));
}
function blocoCheckins(data, hoje) {
  const cs = checkinsEmFalta(data, hoje);
  if (!cs.length) return null;
  return { titulo: "🌱 Check-ins por enviar", linhas: lista(cs.map((c) => `• ${c.nome} — ${c.rot}`)) };
}

function financasDoMes(data, hoje) {
  const mes = hoje.slice(0, 7);
  const tx = data.finance?.transactions || [];
  const rec = tx.filter((t) => t.type === "receita" && (t.date || "").startsWith(mes)).reduce((s, t) => s + (Number(t.amount) || 0), 0);
  return { rec, meta: Number(data.finance?.metaMensal) || 0 };
}
function blocoMeta(data, hoje) {
  const { rec, meta } = financasDoMes(data, hoje);
  if (!meta) return null;
  return { titulo: "🏁 Meta do mês", linhas: [`• ${eur(rec)} de ${eur(meta)} (${Math.round((rec / meta) * 100)}%)`] };
}

/* ---------- o que aconteceu hoje (para o resumo da noite) ---------- */
function blocoFeitoHoje(data, hoje) {
  const linhas = [];
  const tx = (data.finance?.transactions || []).filter((t) => t.date === hoje);
  const rec = tx.filter((t) => t.type === "receita");
  const desp = tx.filter((t) => t.type === "despesa");
  if (rec.length) linhas.push(`• Entraram ${eur(rec.reduce((s, t) => s + (Number(t.amount) || 0), 0))} (${rec.length} receita${rec.length > 1 ? "s" : ""})`);
  if (desp.length) linhas.push(`• Saíram ${eur(desp.reduce((s, t) => s + (Number(t.amount) || 0), 0))} (${desp.length} despesa${desp.length > 1 ? "s" : ""})`);
  const novos = (data.sales?.leads || []).filter((l) => l.createdAt === hoje);
  if (novos.length) linhas.push(`• ${novos.length} lead${novos.length > 1 ? "s" : ""} nova${novos.length > 1 ? "s" : ""}: ${lista(novos.map((l) => primeiroNome(l.name)), 6).join(", ")}`);
  let feitas = 0;
  (data.tasks || []).forEach((t) => { if (t.done && (t.doneData === hoje || t.doneEm === hoje)) feitas++; });
  Object.values(data.fichas || {}).forEach((f) => (f.tarefas || []).forEach((t) => { if (t.done && t.doneData === hoje) feitas++; }));
  if (feitas) linhas.push(`• ${feitas} tarefa${feitas > 1 ? "s" : ""} concluída${feitas > 1 ? "s" : ""}`);
  let enviados = 0;
  turmasAtivas(data).forEach((c) => Object.values(c.dossie?.acomp || {}).forEach((x) => MARCOS.forEach(([k]) => { if (x && x[k + "Env"] === hoje) enviados++; })));
  if (enviados) linhas.push(`• ${enviados} check-in${enviados > 1 ? "s" : ""} enviado${enviados > 1 ? "s" : ""}`);
  return linhas.length ? { titulo: "✅ Feito hoje", linhas } : { titulo: "✅ Feito hoje", linhas: ["• Nada registado no sistema hoje"] };
}

/* ---------- montar as mensagens ---------- */
const render = (blocos) =>
  blocos.filter(Boolean).map((b) => `*${b.titulo}*\n${b.linhas.join("\n")}`);

export function resumoManha(data, hoje) {
  const blocos = [
    blocoTurmas(data, hoje, addDias(hoje, 7), "🎓 Turmas (próximos 7 dias)"),
    blocoAulas(data, hoje, addDias(hoje, 1), hoje, "🔴 Aulas ao vivo"),
    blocoMensagemPosAula(data, hoje),
    blocoTarefasEquipa(data, hoje, hoje, "✅ Tarefas da equipa (hoje e atrasadas)", true),
    blocoTarefasAlunas(data, hoje, 7),
    blocoFollowUps(data, hoje, hoje, "📞 Follow-ups por fazer"),
    blocoCheckins(data, hoje),
    blocoRecuperar(data),
    blocoPagamentos(data, hoje),
    blocoLeads(data),
    blocoMeta(data, hoje),
  ];
  const partes = render(blocos);
  const cab = `☀️ *Bom dia, Jonas!* ${fmtData(hoje)}\n*Academy — o que tem de ser feito hoje*`;
  return [cab, ...(partes.length ? partes : ["Sem pendentes no sistema. Dia livre para vender e criar. 🙌"])];
}

export function resumoNoite(data, hoje) {
  const amanha = addDias(hoje, 1);
  const blocos = [
    blocoFeitoHoje(data, hoje),
    blocoAulas(data, hoje, hoje, hoje, "🔴 Aula ao vivo esta noite"),
    blocoTarefasEquipa(data, hoje, hoje, "⏳ Ficou por fazer hoje", true),
    blocoFollowUps(data, hoje, hoje, "📞 Follow-ups por fazer"),
    blocoCheckins(data, hoje),
    blocoPagamentos(data, hoje),
    blocoTurmas(data, amanha, amanha, "📅 Turma amanhã"),
    blocoAulas(data, amanha, amanha, hoje, "📅 Aula ao vivo amanhã"),
    (() => {
      const t = (data.tasks || []).filter((x) => !x.done && x.due === amanha);
      return t.length
        ? { titulo: "📅 Tarefas para amanhã", linhas: lista(t.map((x) => `• ${x.title}${x.assignee ? ` — ${primeiroNome(x.assignee)}` : ""}`)) }
        : null;
    })(),
    blocoMeta(data, hoje),
  ];
  const cab = `🌙 *Fecho do dia — Academy* ${fmtData(hoje)}`;
  return [cab, ...render(blocos)];
}

/* junta blocos em mensagens de até MAX_MSG caracteres, sem partir secções */
export function agrupar(partes) {
  const msgs = [];
  let atual = "";
  for (const p of partes) {
    if (atual && (atual + "\n\n" + p).length > MAX_MSG) { msgs.push(atual); atual = p; }
    else atual = atual ? atual + "\n\n" + p : p;
  }
  if (atual) msgs.push(atual);
  return msgs;
}

/* ---------- envio ---------- */
async function enviarWhatsApp(env, texto) {
  const u = new URL("https://api.callmebot.com/whatsapp.php");
  u.searchParams.set("phone", env.CALLMEBOT_PHONE);
  u.searchParams.set("apikey", env.CALLMEBOT_APIKEY);
  u.searchParams.set("text", texto);
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error("CallMeBot " + r.status);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function correr(env, tipo, enviar) {
  const { iso } = agoraLisboa();
  let msgs;
  try {
    const data = await lerSistema(env);
    msgs = agrupar(tipo === "manha" ? resumoManha(data, iso) : resumoNoite(data, iso));
  } catch (e) {
    msgs = [`⚠️ Lembrete Academy: não consegui ler o sistema (${e.message}). Abra o sistema e veja se está a carregar.`];
  }
  if (enviar) {
    for (let i = 0; i < msgs.length; i++) {
      if (i) await esperar(3000);
      await enviarWhatsApp(env, msgs[i]);
    }
  }
  return msgs;
}

export default {
  // corre de hora a hora (07h, 08h, 19h, 20h UTC) e só envia quando em Lisboa são 08h ou 20h
  async scheduled(event, env, ctx) {
    const { hora } = agoraLisboa();
    const tipo = hora === HORA_MANHA ? "manha" : hora === HORA_NOITE ? "noite" : null;
    if (tipo) ctx.waitUntil(correr(env, tipo, true));
  },

  // teste no browser: /?acao=manha&chave=TEST_KEY  (só mostra)  |  &enviar=1 (mostra e envia)
  async fetch(request, env) {
    const u = new URL(request.url);
    if (!env.TEST_KEY || u.searchParams.get("chave") !== env.TEST_KEY)
      return new Response("lembrete-academy ativo", { status: 200 });
    const tipo = u.searchParams.get("acao") === "noite" ? "noite" : "manha";
    const msgs = await correr(env, tipo, u.searchParams.get("enviar") === "1");
    return new Response(msgs.map((m, i) => `--- mensagem ${i + 1} ---\n${m}`).join("\n\n"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
