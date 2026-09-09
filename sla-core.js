/* ============================================================================
   sla-core.js — Camada ÚNICA de comunicação, SLA, eventos, segurança e
   sincronização do MÓDULO DE ACIONAMENTO (Assistência 24h).

   Este arquivo NÃO altera layout, cálculos ou fluxo já existentes.
   Ele apenas ACRESCENTA a integração com o backend/sistema principal:

     • registrarEvento({...})  → camada única para todo evento operacional
     • SLA configurável (não fica preso no HTML — vem da API/banco)
     • Estados: DENTRO_DO_SLA / PROXIMO_DO_LIMITE / SLA_EXCEDIDO
     • Horário OFICIAL do servidor (o cronômetro na tela é só visual)
     • Idempotência (evita aceite / recusa / status duplicados)
     • Fila offline + reenvio automático ("AGUARDANDO SINCRONIZAÇÃO")
     • Segurança do link: atendimento_id + prestador_id + token + validade
     • Publicação em tempo real para o painel da central

   Para ligar no sistema real basta definir, ANTES de carregar este arquivo:

     window.ACIONAMENTO_CONFIG = {
       apiBase: 'https://api.suaempresa.com.br',   // endpoints REST
       // sla e limites podem vir do backend em /acionamentos/:id/config
     };

   Sem apiBase, roda com um backend SIMULADO (localStorage) para demonstração,
   mantendo exatamente o mesmo contrato de dados do backend real.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- Config */
  const PADROES = {
    apiBase: null,                       // ex.: 'https://api.suaempresa.com.br'
    canalCentral: 'central-acionamentos',// BroadcastChannel p/ painel da central
    proximoDoLimite: 0.75,               // a partir de 75% do limite → amarelo
    // SLA padrão (fallback). O SLA REAL é carregado do backend em carregarConfig().
    sla: {
      aceite_prestador_seg: 300,         // SLA 1: central → aceite do prestador (5 min)
      envio_motorista_seg: 180           // SLA 2: aceite → envio ao motorista (3 min)
    }
  };

  const config = deepMerge(PADROES, global.ACIONAMENTO_CONFIG || {});

  /* --------------------------------------------------------------- Estado */
  let offsetMs = 0;                      // servidor - cliente (relógio oficial)
  const pendencias = Object.create(null);// idempotency_key → {resolve, reject}
  const K_FILA = 'sla_fila_v1';
  const K_ENVIADOS = 'sla_enviados_v1';
  let canal = null;
  try { canal = ('BroadcastChannel' in global) ? new BroadcastChannel(config.canalCentral) : null; } catch (_) {}

  /* --------------------------------------------------------------- Utils */
  function deepMerge(a, b) {
    const out = Array.isArray(a) ? a.slice() : Object.assign({}, a);
    for (const k in b) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) out[k] = deepMerge(a[k] || {}, b[k]);
      else out[k] = b[k];
    }
    return out;
  }
  function uuid() {
    try { if (global.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  function lerLS(k, def) { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch (_) { return def; } }
  function gravarLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

  /** Relógio OFICIAL (cliente + offset do servidor). */
  function agoraServidor() { return Date.now() + offsetMs; }
  function aplicarOffset(servidorHoraMs) {
    if (typeof servidorHoraMs === 'number' && isFinite(servidorHoraMs)) {
      offsetMs = servidorHoraMs - Date.now();
    }
  }

  /* ------------------------------------------------------------ Formatação */
  function pad(n) { return String(n).padStart(2, '0'); }
  function hhmm(ms) { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function mmss(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    return (h > 0 ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
  }

  /* ------------------------------------------------------------- SLA core */
  const ROTULO_ESTADO = {
    DENTRO_DO_SLA:     'Dentro do SLA',
    PROXIMO_DO_LIMITE: 'Próximo do limite',
    SLA_EXCEDIDO:      'SLA EXCEDIDO'
  };
  const CLASSE_ESTADO = {
    DENTRO_DO_SLA:     'estado-ok',
    PROXIMO_DO_LIMITE: 'estado-alerta',
    SLA_EXCEDIDO:      'estado-excedido'
  };

  /** Avalia o estado do SLA a partir do tempo decorrido (oficial). */
  function avaliarSLA(decorridoSeg, limiteSeg, proximoPct) {
    proximoPct = (typeof proximoPct === 'number') ? proximoPct : config.proximoDoLimite;
    if (!limiteSeg || limiteSeg <= 0) return 'DENTRO_DO_SLA';
    if (decorridoSeg >= limiteSeg) return 'SLA_EXCEDIDO';
    if (decorridoSeg >= limiteSeg * proximoPct) return 'PROXIMO_DO_LIMITE';
    return 'DENTRO_DO_SLA';
  }

  /**
   * Cronômetro VISUAL. Mostra o tempo em tempo real e pinta o estado do SLA.
   * IMPORTANTE: é apenas visual. O resultado OFICIAL do SLA é calculado com os
   * horários registrados no servidor (ver resultadoSLA()).
   */
  class Cronometro {
    constructor(opts) {
      this.inicio = opts.inicioServidor;        // ms (relógio oficial)
      this.limiteSeg = opts.limiteSeg;
      this.elTempo = opts.elTempo;
      this.elEstado = opts.elEstado;
      this.elCaixa = opts.elCaixa || null;
      this.proximoPct = opts.proximoPct;
      this.onEstado = opts.onEstado || null;
      this._id = null;
      this._estado = null;
      this._parado = false;
    }
    _pintar(el) {
      Object.values(CLASSE_ESTADO).forEach(c => el && el.classList.remove(c));
    }
    tick() {
      if (this._parado) return;
      const decorrido = agoraServidor() - this.inicio;
      if (this.elTempo) this.elTempo.textContent = mmss(decorrido);
      const estado = avaliarSLA(decorrido / 1000, this.limiteSeg, this.proximoPct);
      if (estado !== this._estado) {
        this._estado = estado;
        [this.elEstado, this.elCaixa, this.elTempo].forEach(el => {
          if (!el) return;
          this._pintar(el);
          el.classList.add(CLASSE_ESTADO[estado]);
        });
        if (this.elEstado) this.elEstado.textContent = ROTULO_ESTADO[estado];
        if (this.onEstado) this.onEstado(estado);
      }
    }
    iniciar() { this.tick(); this._id = setInterval(() => this.tick(), 500); return this; }
    parar() { this._parado = true; if (this._id) clearInterval(this._id); return agoraServidor() - this.inicio; }
  }

  /** Resultado OFICIAL do SLA para um decorrido (ms) calculado no servidor. */
  function resultadoSLA(decorridoMs, limiteSeg) {
    return (decorridoMs / 1000) <= limiteSeg ? 'DENTRO_DO_SLA' : 'SLA_EXCEDIDO';
  }

  /* ------------------------------------------------------- Backend real */
  async function httpJSON(metodo, caminho, corpo, headers) {
    const resp = await fetch(config.apiBase.replace(/\/$/, '') + caminho, {
      method: metodo,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: corpo ? JSON.stringify(corpo) : undefined
    });
    if (!resp.ok) {
      const err = new Error('HTTP ' + resp.status);
      err.status = resp.status;
      err.definitivo = resp.status >= 400 && resp.status < 500 && resp.status !== 409 && resp.status !== 429;
      throw err;
    }
    return resp.json();
  }

  /* -------------------------------------------------- Backend SIMULADO */
  /* Reproduz o contrato do backend real usando localStorage. Usado apenas
     quando não há apiBase configurada. Sempre devolve horário OFICIAL. */
  const Simulado = {
    _log(atd) { return lerLS('sla_log_' + atd, []); },
    _grava(atd, arr) { gravarLS('sla_log_' + atd, arr); },

    linhaTempo(atd) {
      const log = this._log(atd);
      let enviado = log.find(e => e.evento === 'ACIONAMENTO_ENVIADO');
      if (!enviado) {
        // A central "acabou de enviar" — simula 1 min de diferença p/ leitura.
        const t = Date.now() - 60000;
        enviado = { evento: 'ACIONAMENTO_ENVIADO', servidor_hora: t, evento_id: uuid() };
        log.unshift(enviado);
        this._grava(atd, log);
      }
      const visto = log.find(e => e.evento === 'ACIONAMENTO_VISUALIZADO');
      return {
        atendimento_id: atd,
        enviado_em: enviado.servidor_hora,
        visualizado_em: visto ? visto.servidor_hora : null,
        servidor_hora: Date.now(),
        eventos: log
      };
    },

    registrar(evt) {
      const enviados = lerLS(K_ENVIADOS, {});
      if (enviados[evt.idempotency_key]) {
        // Idempotência: mesma chave → devolve o resultado já registrado.
        return Object.assign({ ok: true, duplicado: true }, enviados[evt.idempotency_key]);
      }
      const resp = {
        ok: true,
        evento_id: uuid(),
        evento: evt.evento,
        status: evt.status || null,
        servidor_hora: Date.now()
      };
      const log = this._log(evt.atendimento_id);
      log.push(Object.assign({}, evt, resp));
      this._grava(evt.atendimento_id, log);
      enviados[evt.idempotency_key] = resp;
      gravarLS(K_ENVIADOS, enviados);
      return resp;
    },

    validarAcesso(p) {
      // Sem backend real: aceita link de demonstração (sem token) e
      // valida coerência básica quando token/validade forem informados.
      if (p.validade) {
        const val = typeof p.validade === 'number' ? p.validade : Date.parse(p.validade);
        if (isFinite(val) && val < Date.now()) return { ok: false, motivo: 'LINK_EXPIRADO' };
      }
      if (p.token && p.token.length < 8) return { ok: false, motivo: 'TOKEN_INVALIDO' };
      return { ok: true, atendimento_id: p.atendimento_id, prestador_id: p.prestador_id, motorista_id: p.motorista_id };
    }
  };

  /* -------------------------------------------------------- Envio / Fila */
  /* Offline é decidido pela FALHA real do fetch (API real). O backend
     simulado é local (localStorage), portanto só "cai" quando o modo de
     teste SLA.simularOffline é ligado explicitamente. */
  function simulandoOffline() { return !!(global.SLA && global.SLA.simularOffline); }

  async function enviarAgora(evt) {
    let resp;
    if (config.apiBase) {
      resp = await httpJSON('POST', '/acionamentos/' + encodeURIComponent(evt.atendimento_id) + '/eventos',
        evt, { 'Idempotency-Key': evt.idempotency_key });
    } else {
      if (simulandoOffline()) { const e = new Error('OFFLINE'); e.offline = true; throw e; }
      resp = Simulado.registrar(evt);
    }
    aplicarOffset(resp.servidor_hora);
    marcarConfirmado(evt, resp);
    return resp;
  }

  function marcarConfirmado(evt, resp) {
    publicarCentral(evt, resp);
    dispararEvento('acionamento:evento', { evt, resp });
    const p = pendencias[evt.idempotency_key];
    if (p) { delete pendencias[evt.idempotency_key]; p.resolve(resp); }
  }

  function enfileirar(evt) {
    const fila = lerLS(K_FILA, []);
    if (!fila.some(e => e.idempotency_key === evt.idempotency_key)) { fila.push(evt); gravarLS(K_FILA, fila); }
    dispararEvento('acionamento:pendente', { evt });
  }

  let flushando = false;
  async function flush() {
    if (flushando) return;
    flushando = true;
    try {
      let fila = lerLS(K_FILA, []);
      const restantes = [];
      for (const evt of fila) {
        try { await enviarAgora(evt); }
        catch (e) { if (e.definitivo) { rejeitar(evt, e); } else { restantes.push(evt); } }
      }
      gravarLS(K_FILA, restantes);
      if (restantes.length === 0) dispararEvento('acionamento:sincronizado', {});
    } finally { flushando = false; }
  }

  function rejeitar(evt, e) {
    const p = pendencias[evt.idempotency_key];
    if (p) { delete pendencias[evt.idempotency_key]; p.reject(e); }
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('online', flush);
    // Tentativa periódica leve enquanto houver pendências.
    setInterval(() => { if (lerLS(K_FILA, []).length) flush(); }, 15000);
  }

  /* ------------------------------------------------------ Tempo real */
  function publicarCentral(evt, resp) {
    const msg = {
      atendimento_id: evt.atendimento_id,
      prestador_id: evt.prestador_id || null,
      motorista_id: evt.motorista_id || null,
      evento: evt.evento,
      status: evt.status || null,
      servidor_hora: resp.servidor_hora,
      dados_adicionais: evt.dados_adicionais || null
    };
    try { canal && canal.postMessage(msg); } catch (_) {}
  }
  function dispararEvento(nome, det) {
    try { global.dispatchEvent(new CustomEvent(nome, { detail: det })); } catch (_) {}
  }

  /* ============================================================ API pública */

  /**
   * CAMADA ÚNICA de comunicação com o backend.
   * Toda ação da operação passa por aqui — nunca só por mudança de HTML/JS local.
   *
   * @returns Promise que resolve SOMENTE quando o servidor confirma o evento
   *          (imediatamente quando online; após reenvio quando estava offline),
   *          e rejeita apenas em falha definitiva do servidor.
   */
  function registrarEvento(payload, opts) {
    opts = opts || {};
    const evt = {
      atendimento_id:  payload.atendimento_id,
      prestador_id:    payload.prestador_id || null,
      motorista_id:    payload.motorista_id || null,
      evento:          payload.evento,
      status:          payload.status || null,
      latitude:        (payload.latitude != null ? payload.latitude : null),
      longitude:       (payload.longitude != null ? payload.longitude : null),
      km:              (payload.km != null ? payload.km : null),
      dados_adicionais: payload.dados_adicionais || null,
      // Idempotência: por padrão 1 evento de ciclo de vida por ator/atendimento.
      idempotency_key: payload.idempotency_key ||
        [payload.atendimento_id, payload.evento, payload.prestador_id || payload.motorista_id || 'central'].join(':'),
      cliente_hora: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      enviarAgora(evt).then(resolve).catch(err => {
        if (err.definitivo) { reject(err); return; }
        // Falha de comunicação (offline / instável): enfileira e aguarda sincronização.
        pendencias[evt.idempotency_key] = { resolve, reject };
        enfileirar(evt);
        if (opts.onPendente) opts.onPendente(evt);
        flush(); // tenta imediatamente também
      });
    });
  }

  /** Carrega a configuração de SLA do backend (não fica presa no HTML). */
  async function carregarConfig(atendimento_id) {
    if (config.apiBase) {
      try {
        const c = await httpJSON('GET', '/acionamentos/' + encodeURIComponent(atendimento_id) + '/config');
        if (c && c.sla) config.sla = deepMerge(config.sla, c.sla);
        if (c && typeof c.proximoDoLimite === 'number') config.proximoDoLimite = c.proximoDoLimite;
      } catch (_) { /* mantém padrão/fallback */ }
    }
    return { sla: config.sla, proximoDoLimite: config.proximoDoLimite };
  }

  /** Linha do tempo oficial do atendimento (enviado/visualizado/eventos). */
  async function carregarLinhaTempo(atendimento_id) {
    let lt;
    if (config.apiBase) {
      lt = await httpJSON('GET', '/acionamentos/' + encodeURIComponent(atendimento_id) + '/linha-tempo');
    } else {
      lt = Simulado.linhaTempo(atendimento_id);
    }
    aplicarOffset(lt.servidor_hora);
    return lt;
  }

  /**
   * Segurança do link. Valida no backend a combinação
   * atendimento_id + prestador_id (ou motorista_id) + token + validade.
   * Não permite trocar apenas o número do atendimento na URL.
   */
  async function validarAcesso(params) {
    const p = params || lerParamsURL();
    if (!p.atendimento_id) return { ok: false, motivo: 'SEM_ATENDIMENTO' };
    if (config.apiBase) {
      try { return await httpJSON('POST', '/acesso/validar', p); }
      catch (e) { return { ok: false, motivo: e.definitivo ? 'ACESSO_NEGADO' : 'FALHA_VALIDACAO' }; }
    }
    return Simulado.validarAcesso(p);
  }

  /** Lê parâmetros de segurança/identificação da URL. */
  function lerParamsURL() {
    const q = new URLSearchParams(global.location ? global.location.search : '');
    return {
      atendimento_id: q.get('atendimento') || q.get('atendimento_id') || null,
      prestador_id:   q.get('prestador') || q.get('prestador_id') || null,
      motorista_id:   q.get('motorista') || q.get('motorista_id') || null,
      token:          q.get('token') || null,
      validade:       q.get('validade') || q.get('exp') || null
    };
  }

  function temPendencias() { return lerLS(K_FILA, []).length > 0; }

  /* ------------------------------------------------------------- Export */
  global.SLA = {
    config,
    // comunicação
    registrarEvento,
    carregarConfig,
    carregarLinhaTempo,
    validarAcesso,
    lerParamsURL,
    // sla / tempo
    Cronometro,
    avaliarSLA,
    resultadoSLA,
    ROTULO_ESTADO,
    CLASSE_ESTADO,
    agoraServidor,
    // formatação
    hhmm,
    mmss,
    // sincronização
    flush,
    temPendencias,
    simularOffline: false
  };

  // Ao carregar, tenta drenar pendências antigas.
  flush();

})(typeof window !== 'undefined' ? window : this);
