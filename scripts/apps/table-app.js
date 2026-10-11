import { ACTIONS, ACTIVE_STREETS, MODULE_ID, REQUEST, TABLE_STATUS } from "../constants.js";
import { PokerSoundService } from "../audio/sound-service.js";
import { legalActions } from "../engine/legal-actions.js";
import { cardDisplay } from "../engine/cards.js";
import { getPokerSocket } from "../runtime.js";
import { escapeHtml, notifyError, parseStrictInteger } from "../util.js";
import { PokerHistoryApp } from "./history-app.js";
import { PokerSoundSettingsApp } from "./sound-settings-app.js";
import { SeatDialogApp } from "./seat-dialog-app.js";
import { TableSettingsApp } from "./table-settings-app.js";
import { TopUpApp } from "./top-up-app.js";
import { seatEllipsePosition } from "./table-geometry.js";
import { TablePresentation, positionCardOrigins } from "./table-presentation.js";
import { PRESENTATION } from "../presentation-timing.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function actionLabel(action) {
  const key = `FBLPoker.Actions.${action}`;
  const localized = game.i18n.localize(key);
  return localized === key ? action : localized;
}

function cardView(card, hidden = false) {
  if (hidden) return { hidden: true, rank: "", symbol: "", red: false, label: game.i18n.localize("FBLPoker.Table.HiddenCard") };
  return { ...cardDisplay(card), hidden: false, label: `${cardDisplay(card).rank} ${game.i18n.localize(`FBLPoker.Suits.${card.slice(-1)}`)}` };
}

export class PokerTableApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fbl-poker", "fbl-poker-table-app"],
    position: { width: 1280, height: 860 },
    window: {
      contentClasses: ["fbl-poker-content"],
      title: "FBLPoker.Table.Title",
      icon: "fa-solid fa-spade",
      resizable: true
    },
    actions: {
      joinSeat: PokerTableApp.joinSeat,
      cashOut: PokerTableApp.cashOut,
      openTopUp: PokerTableApp.openTopUp,
      toggleSitOut: PokerTableApp.toggleSitOut,
      toggleSitOutAfterHand: PokerTableApp.toggleSitOutAfterHand,
      toggleLeaveAfterHand: PokerTableApp.toggleLeaveAfterHand,
      pokerAction: PokerTableApp.pokerAction,
      quickAmount: PokerTableApp.quickAmount,
      toggleCards: PokerTableApp.toggleCards,
      toggleLog: PokerTableApp.toggleLog
    }
  };

  static PARTS = {
    body: { template: "modules/fbl-poker-table/templates/table.hbs" }
  };

  constructor({ tableId, ...options } = {}) {
    super({ id: `fbl-poker-table-${tableId}`, ...options });
    this.tableId = tableId;
    this._stateHook = (_tables, changes) => {
      if (changes?.changedTableIds && !changes.changedTableIds.has(this.tableId) && !changes.deletedTableIds?.has(this.tableId)) return;
      this.render();
    };
    this._privateHook = (data) => {
      if (data.tableId !== this.tableId) return;
      const table = getPokerSocket().getTable(this.tableId);
      if (!table || table.handNumber !== data.handNumber) return;
      this.render();
    };
    this._countdownTimer = null;
    this._pendingSoundEvents = [];
    this._presentation = new TablePresentation();
    this._resultRenderTimer = null;
    this._resizeObserver = null;
    this._turnSoundController = new AbortController();
    this._motionPreference = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    this._motionChanged = () => this.render();
    this._dismissContextMenu = null;
    this.logCollapsed = false;
    this._soundController = new AbortController();
    this._actionPending = false;
    this._raiseDraft = null;
  }

  get title() {
    const table = getPokerSocket().getTable(this.tableId);
    if (!table) return game.i18n.localize("FBLPoker.Table.Title");
    const status = game.i18n.localize(`FBLPoker.Status.${table.paused ? "paused" : table.status}`);
    const hand = `${game.i18n.localize("FBLPoker.Table.Hand")} #${table.handNumber}`;
    const blinds = `${table.smallBlind}/${table.bigBlind}${table.ante ? ` · ${game.i18n.localize("FBLPoker.Fields.Ante")} ${table.ante}` : ""}`;
    return `${table.name} · ${status} · ${hand} · ${blinds}`;
  }

  _getHeaderControls() {
    try {
      return super._getHeaderControls();
    } catch (_error) {
      return [];
    }
  }

  _syncWindowTitle() {
    const application = this.element?.closest?.(".application") ?? this.element?.parentElement;
    const titleElement = application?.querySelector?.(".window-header .window-title")
      ?? application?.querySelector?.(".window-title");
    if (!titleElement) return;
    const title = this.title;
    titleElement.textContent = title;
    titleElement.title = title;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const table = getPokerSocket().getTable(this.tableId);
    if (!table) {
      this._soundController.abort();
      this._turnSoundController.abort();
      this._pendingSoundEvents = [];
      this._presentation = new TablePresentation();
      return { missing: true };
    }

    const active = ACTIVE_STREETS.has(table.status);
    const socket = getPokerSocket();
    const presentation = this._presentation.update(table, {
      reducedMotion: this._motionPreference?.matches ?? false,
      ownTurn: table.seats[table.currentSeat]?.userId === game.user.id && !socket.isAutomatedSeat(table.id, table.currentSeat)
    });
    if (presentation.cancelSounds) {
      this._soundController.abort();
      this._soundController = new AbortController();
      this._pendingSoundEvents = [];
    }
    if (presentation.cancelTurn) {
      this._turnSoundController.abort();
      this._turnSoundController = new AbortController();
      this._pendingSoundEvents = this._pendingSoundEvents.filter(event => !event.turn);
    }
    this._pendingSoundEvents.push(...presentation.sounds);
    const effect = key => this._presentation.effect(key);
    const potAnimated = Boolean(effect("pot"));
    const winningSeats = new Set((table.status === TABLE_STATUS.COMPLETE && !presentation.resultPending ? table.lastResult?.awards : [])?.filter((award) => {
      const actorId = award.actorId ?? table.handHistory?.find(hand => hand.handNumber === table.handNumber)?.participants?.find(p => p.seatIndex === award.seatIndex)?.actorId;
      return actorId && table.seats[award.seatIndex]?.actorId === actorId;
    }).map((award) => award.seatIndex) ?? []);
    const optionalRevealSeats = new Set(
      table.status === TABLE_STATUS.COMPLETE && table.lastResult?.type === "uncontested"
        ? (table.lastResult.awards ?? []).map((award) => award.seatIndex)
        : []
    );
    const seatViews = table.seats.map((seat, index) => {
      const { left, top } = seatEllipsePosition(index, table.maxSeats);
      const style = `left:${left}%;top:${top}%`;
      if (!seat) return { index, empty: true, style, canJoin: !active };

      const automated = socket.isAutomatedSeat(table.id, index);
      const ownSeat = seat.userId === game.user.id && !automated;
      const privateCards = socket.getPrivateHand(table.id, table.handNumber, index);
      const visibleCards = seat.revealedCards?.length ? seat.revealedCards : (ownSeat ? privateCards : []);
      const rawCards = visibleCards.length
        ? visibleCards.map((card) => cardView(card))
        : Array.from({ length: seat.cardsCount || (seat.inHand ? 2 : 0) }, () => cardView(null, true));
      const cards = rawCards.map((card, cardIndex) => {
        const key = `hole:${index}:${cardIndex}`;
        const animation = effect(key);
        return {
          ...card,
          effectKey: key,
          animateDeal: Boolean(animation),
          dealDelay: animation?.delay ?? 0
        };
      });
      const canManage = ownSeat || game.user.isGM;
      const cardsRevealed = Boolean(seat.revealedCards?.length);
      const canToggleCards = canManage
        && table.status === TABLE_STATUS.COMPLETE
        && optionalRevealSeats.has(index)
        && seat.cardsCount > 0;
      const chipAnimated = Boolean(effect(`chips:${index}`));

      const betPlacement = Math.abs(left - 50) < 8
        ? (top < 50 ? "below-center" : "above-center")
        : (left < 50 ? "right-side" : "left-side");

      return {
        ...seat,
        style,
        betPlacement,
        empty: false,
        ownSeat,
        automated,
        canManage,
        cardsRevealed,
        canToggleCards,
        canImmediateManage: canManage && !active,
        canQueue: canManage && active && seat.inHand,
        canTopUp: canManage && !active && seat.stack < table.maxBuyIn,
        current: table.currentSeat === index,
        isActing: table.currentSeat === index && !table.paused,
        winner: winningSeats.has(index),
        dealer: table.dealerIndex === index,
        smallBlind: table.smallBlindIndex === index,
        bigBlind: table.bigBlindIndex === index,
        cards,
        showBetChips: seat.streetBet > 0,
        chipAnimated,
        lastActionText: seat.lastAction ? `${actionLabel(seat.lastAction.type)}${seat.lastAction.amount ? ` ${seat.lastAction.amount}` : ""}` : ""
      };
    });

    const cardRevealSeat = table.status === TABLE_STATUS.COMPLETE
      ? seatViews.find((seat) => !seat.empty && seat.ownSeat && seat.canToggleCards) ?? null
      : null;
    const actingSeat = table.currentSeat === null ? null : table.seats[table.currentSeat];
    const actingSeatAutomated = table.currentSeat === null ? false : socket.isAutomatedSeat(table.id, table.currentSeat);
    const canActForSeat = actingSeat && !actingSeatAutomated && socket.hasAutomationInfo?.(table.id) !== false && (actingSeat.userId === game.user.id || game.user.isGM);
    const availableLegal = legalActions(table, actingSeat);
    const legal = canActForSeat ? availableLegal : null;
    const eligibleCount = table.seats.filter((seat) => seat && !seat.sittingOut && !seat.leaveAfterHand && !seat.sitOutAfterHand && seat.stack > 0).length;

    const community = Array.from({ length: 5 }, (_, index) => {
      if (!table.community[index]) return { empty: true };
      return {
        ...cardView(table.community[index]),
        effectKey: `board:${index}`,
        animateDeal: Boolean(effect(`board:${index}`)),
        dealDelay: effect(`board:${index}`)?.delay ?? 0
      };
    });

    const logs = (table.log ?? []).slice(0, 35).map((entry) => {
      const legacyHand = table.handHistory?.find((hand) => hand.handNumber === entry.handNumber || hand.actions?.some((action) => action.id === entry.id));
      const legacyActor = legacyHand?.participants?.find((participant) => participant.seatIndex === entry.seatIndex);
      let text = game.i18n.localize(`FBLPoker.Log.${entry.type}`);
      if (text === `FBLPoker.Log.${entry.type}`) text = actionLabel(entry.type);
      if (entry.type === "street" && typeof entry.amount === "string") text += `: ${game.i18n.localize(`FBLPoker.Status.${entry.amount}`)}`;
      return {
        id: entry.id,
        actorName: entry.actorName ?? legacyActor?.actorName ?? "",
        text,
        amount: typeof entry.amount === "number" ? entry.amount : null
      };
    });

    const awardTotals = new Map();
    for (const award of (table.status === TABLE_STATUS.COMPLETE && !presentation.resultPending ? table.lastResult?.awards : []) ?? []) {
      const current = awardTotals.get(award.seatIndex) ?? { seatIndex: award.seatIndex, actorName: award.actorName, amount: 0, categoryName: award.categoryName ?? null };
      current.amount += Number(award.amount) || 0;
      if (!current.categoryName && award.categoryName) current.categoryName = award.categoryName;
      awardTotals.set(award.seatIndex, current);
    }
    const resultAwards = [...awardTotals.values()].map((award) => ({
      ...award,
      actorName: award.actorName ?? table.handHistory?.find((hand) => hand.handNumber === table.handNumber)?.participants?.find((p) => p.seatIndex === award.seatIndex)?.actorName ?? "?",
      categoryLabel: award.categoryName ? game.i18n.localize(`FBLPoker.Hands.${award.categoryName}`) : ""
    }));

    const draftKey = JSON.stringify([table.handNumber, table.status, table.currentSeat, actingSeat?.actorId, availableLegal?.minTarget, availableLegal?.maxTarget]);
    if (draftKey !== this._raiseDraft?.key) this._raiseDraft = { key: draftKey, value: legal?.minTarget };
    Object.assign(context, {
      expected: { handNumber: table.handNumber, status: table.status, revision: table.revision },
      raiseValue: this._raiseDraft.value,
      actionPending: this._actionPending,
      blockedMessage: table.recoveryRequired ? game.i18n.localize("FBLPoker.Errors.RecoveryRequired") : table.deliveryPending ? game.i18n.localize("FBLPoker.Table.WaitingForCards") : "",
      displayedPot: table.status === TABLE_STATUS.COMPLETE ? (table.lastResult?.potTotal ?? table.handHistory?.[0]?.potTotal ?? 0) : table.potTotal,
      potLabel: game.i18n.localize(table.status === TABLE_STATUS.COMPLETE ? "FBLPoker.Table.AwardedPot" : "FBLPoker.Table.Pot"),
      missing: false,
      table,
      isGM: game.user.isGM,
      active,
      paused: table.paused,
      statusLabel: game.i18n.localize(`FBLPoker.Status.${table.paused ? "paused" : table.status}`),
      seats: seatViews,
      community,
      logs,
      legal,
      actingSeat,
      cardRevealControl: cardRevealSeat ? {
        seatIndex: cardRevealSeat.index,
        revealed: cardRevealSeat.cardsRevealed
      } : null,
      canStart: game.user.isGM && !active && eligibleCount >= 2,
      canPause: game.user.isGM && active,
      canForceReset: game.user.isGM && active,
      canEdit: game.user.isGM && !active,
      resultAwards,
      hasResult: resultAwards.length > 0 && !presentation.resultPending,
      historyCount: table.handHistory?.length ?? 0,
      logCollapsed: this.logCollapsed,
      deckDealing: Boolean(effect("deck")),
      deckDealCycles: (effect("deck")?.duration ?? 0) / PRESENTATION.deckCycle,
      autoNextWaiting: table.status === TABLE_STATUS.COMPLETE && table.autoNextHand && Boolean(table.nextHandDeadline),
      potAnimated
    });

    return context;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    if (this._soundController.signal.aborted) this._soundController = new AbortController();
    if (this._turnSoundController.signal.aborted) this._turnSoundController = new AbortController();
    this._motionPreference?.addEventListener("change", this._motionChanged);
    Hooks.on("fblPokerStateUpdated", this._stateHook);
    Hooks.on("fblPokerPrivateUpdated", this._privateHook);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._renderedAction = { expected: context.expected, seatIndex: context.actingSeat?.index };
    this._syncWindowTitle();
    this.#renderHeaderButtons();
    this.#bindSeatContextMenus();
    this.#syncPresentation();
    this.#playPendingSounds();
    clearInterval(this._countdownTimer);
    this._countdownTimer = null;

    const timer = this.element?.querySelector?.("[data-turn-timer]");
    const autoNext = this.element?.querySelector?.("[data-auto-next-countdown]");
    const secondsElement = timer?.querySelector?.("[data-turn-timer-seconds]") ?? null;
    const barElement = timer?.querySelector?.("[data-turn-timer-bar]") ?? null;

    const updateTimer = () => {
      const table = getPokerSocket().getTable(this.tableId);
      if (autoNext) {
        const remaining = table?.nextHandDeadline ? Math.max(0, Math.ceil(Math.min(table.autoNextHandSeconds * 1000, table.nextHandDeadline - getPokerSocket().hostNow()) / 1000)) : 0;
        autoNext.textContent = String(remaining);
      }
      if (timer) {
        if (!table?.turnDeadline || table.currentSeat === null || table.paused) {
          timer.classList.add("is-hidden");
          if (secondsElement) secondsElement.textContent = "–";
          if (barElement) {
            barElement.style.width = "0%";
            barElement.style.background = "hsl(0 72% 46%)";
          }
        } else {
          const totalMs = Math.max(1000, Number(table.actionSeconds || 0) * 1000);
          const remainingMs = Math.max(0, table.turnDeadline - getPokerSocket().hostNow());
          const ratio = Math.max(0, Math.min(1, remainingMs / totalMs));
          const seconds = Math.max(0, Math.ceil(Math.min(totalMs, remainingMs) / 1000));
          const hue = Math.round(ratio * 120);
          timer.classList.remove("is-hidden");
          if (secondsElement) secondsElement.textContent = String(seconds);
          if (barElement) {
            barElement.style.width = `${Math.max(2, ratio * 100)}%`;
            barElement.style.background = `hsl(${hue} 72% 46%)`;
          }
        }
      }

      const now = getPokerSocket().hostNow();
      const hasActiveDeadline = (table?.turnDeadline ?? 0) > now || (table?.nextHandDeadline ?? 0) > now;
      if (!hasActiveDeadline && this._countdownTimer) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
      }
    };
    updateTimer();
    const timerTable = getPokerSocket().getTable(this.tableId);
    const now = getPokerSocket().hostNow();
    if ((timerTable?.turnDeadline ?? 0) > now || (timerTable?.nextHandDeadline ?? 0) > now) {
      this._countdownTimer = setInterval(updateTimer, 250);
    }

    const numberInput = this.element?.querySelector?.('[name="raiseAmount"]');
    const rangeInput = this.element?.querySelector?.('[name="raiseRange"]');
    if (numberInput && rangeInput) {
      const syncNumber = () => { numberInput.value = rangeInput.value; this._raiseDraft.value = numberInput.value; };
      const syncRange = () => { rangeInput.value = numberInput.value; this._raiseDraft.value = numberInput.value; };
      rangeInput.addEventListener("input", syncNumber);
      numberInput.addEventListener("input", syncRange);
    }
  }

  #renderHeaderButtons() {
    const application = this.element?.closest?.(".application") ?? this.element?.parentElement;
    const header = application?.querySelector?.(".window-header");
    if (!header) return;

    header.querySelectorAll(".fbl-poker-header-inline").forEach((element) => element.remove());
    const table = getPokerSocket().getTable(this.tableId);
    if (!table) return;

    const active = ACTIVE_STREETS.has(table.status);
    const eligibleCount = table.seats.filter((seat) => seat && !seat.sittingOut && !seat.leaveAfterHand && !seat.sitOutAfterHand && seat.stack > 0).length;
    const container = document.createElement("div");
    container.className = "fbl-poker-header-inline";

    const actions = [];
    if (game.user.isGM) {
      if (table.recoveryRequired) actions.push({ icon: "fa-solid fa-scale-balanced", title: game.i18n.localize("FBLPoker.Recovery.Title"), onClick: () => PokerTableApp.reconcile.call(this) });
      actions.push(
        {
          icon: "fa-solid fa-play",
          title: game.i18n.localize("FBLPoker.Table.StartHand"),
          disabled: active || table.recoveryRequired || eligibleCount < 2,
          className: "start",
          onClick: () => PokerTableApp.startHand.call(this)
        },
        {
          icon: table.paused ? "fa-solid fa-play" : "fa-solid fa-pause",
          title: table.paused ? game.i18n.localize("FBLPoker.Table.Resume") : game.i18n.localize("FBLPoker.Table.Pause"),
          disabled: !active,
          onClick: () => PokerTableApp.togglePause.call(this)
        },
        {
          icon: "fa-solid fa-rotate-left",
          title: game.i18n.localize("FBLPoker.Table.ForceReset"),
          disabled: !active,
          className: "danger",
          onClick: () => PokerTableApp.forceReset.call(this)
        }
      );
      actions.push({
        icon: table.autoNextHand ? "fa-solid fa-forward-step" : "fa-solid fa-forward",
        title: game.i18n.format("FBLPoker.Table.AutoNextToggle", { seconds: table.autoNextHandSeconds }),
        className: table.autoNextHand ? "active" : "",
        onClick: () => PokerTableApp.toggleAutoNext.call(this)
      });
      actions.push({
        icon: "fa-solid fa-volume-high",
        title: game.i18n.localize("FBLPoker.SoundSettings.Title"),
        onClick: () => PokerTableApp.openSoundSettings.call(this)
      });
    }
    actions.push({
      icon: "fa-solid fa-clock-rotate-left",
      title: `${game.i18n.localize("FBLPoker.History.Title")} (${table.handHistory?.length ?? 0})`,
      onClick: () => PokerTableApp.openHistory.call(this)
    });
    if (game.user.isGM && !active) {
      actions.push({
        icon: "fa-solid fa-sliders",
        title: game.i18n.localize("FBLPoker.Edit.Title"),
        onClick: () => PokerTableApp.editTable.call(this)
      });
    }
    actions.push({
      icon: "fa-solid fa-rotate",
      title: game.i18n.localize("FBLPoker.Common.Refresh"),
      onClick: () => PokerTableApp.refresh.call(this)
    });

    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `header-control icon fbl-poker-header-icon ${action.className ?? ""}`.trim();
      button.title = action.title;
      button.setAttribute("aria-label", action.title);
      button.disabled = Boolean(action.disabled);
      button.innerHTML = `<i class="${action.icon}"></i>`;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!button.disabled) action.onClick();
      });
      container.append(button);
    }

    const closeButton = header.querySelector('[data-action="close"]')
      ?? header.querySelector('.header-control.close')
      ?? header.querySelector('.window-header .close');
    if (closeButton) header.insertBefore(container, closeButton);
    else header.append(container);
  }

  #bindSeatContextMenus() {
    this._dismissContextMenu?.();
    let portal = null;
    let activeTrigger = null;

    const closePortal = ({ restoreFocus = false } = {}) => {
      portal?.remove();
      portal = null;
      if (activeTrigger) {
        activeTrigger.setAttribute("aria-expanded", "false");
        if (restoreFocus) activeTrigger.focus?.({ preventScroll: true });
      }
      activeTrigger = null;
    };
    const dismiss = (event) => {
      if (portal?.contains(event?.target) || activeTrigger?.contains?.(event?.target)) return;
      closePortal();
    };
    const openPortal = (sourceMenu, { clientX, clientY, trigger = null }) => {
      if (!sourceMenu) return;
      closePortal();

      const menu = sourceMenu.cloneNode(true);
      menu.classList.remove("open-left", "open-up");
      menu.classList.add("open", "fbl-poker-context-portal");
      menu.style.left = "-10000px";
      menu.style.top = "-10000px";
      menu.style.visibility = "hidden";
      document.body.append(menu);
      portal = menu;
      activeTrigger = trigger;
      activeTrigger?.setAttribute("aria-expanded", "true");

      const rect = menu.getBoundingClientRect();
      const viewportWidth = document.documentElement?.clientWidth ?? window.innerWidth;
      const viewportHeight = document.documentElement?.clientHeight ?? window.innerHeight;
      const padding = 8;
      const offset = 6;
      let left = clientX + offset;
      let top = clientY + offset;
      if (left + rect.width + padding > viewportWidth) left = clientX - rect.width - offset;
      if (top + rect.height + padding > viewportHeight) top = clientY - rect.height - offset;
      left = Math.max(padding, Math.min(left, viewportWidth - rect.width - padding));
      top = Math.max(padding, Math.min(top, viewportHeight - rect.height - padding));
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
      menu.style.visibility = "visible";

      menu.addEventListener("click", (menuEvent) => {
        const target = menuEvent.target?.closest?.("[data-action]");
        if (!target || !menu.contains(target)) return;
        menuEvent.preventDefault();
        menuEvent.stopPropagation();
        const handler = PokerTableApp.DEFAULT_OPTIONS.actions?.[target.dataset.action];
        closePortal();
        if (typeof handler === "function") {
          Promise.resolve(handler.call(this, menuEvent, target)).catch(notifyError);
        }
      });

      menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closePortal({ restoreFocus: true });
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = [...menu.querySelectorAll('button:not(:disabled)')];
        if (!items.length) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement);
        let next = current;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        else if (event.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
        else next = (current - 1 + items.length) % items.length;
        items[next].focus({ preventScroll: true });
      });

      menu.querySelector("button:not(:disabled)")?.focus?.({ preventScroll: true });
    };

    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("scroll", closePortal, true);
    window.addEventListener("resize", closePortal);
    window.addEventListener("blur", closePortal);
    this._dismissContextMenu = () => {
      closePortal();
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("scroll", closePortal, true);
      window.removeEventListener("resize", closePortal);
      window.removeEventListener("blur", closePortal);
    };

    this.element?.querySelectorAll?.(".fbl-poker-seat[data-can-manage='true']").forEach((seatElement) => {
      const sourceMenu = seatElement.querySelector("[data-seat-context-menu]");
      const trigger = seatElement.querySelector("[data-seat-menu-trigger]");
      if (!sourceMenu) return;

      seatElement.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPortal(sourceMenu, { clientX: event.clientX, clientY: event.clientY });
      });

      trigger?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = trigger.getBoundingClientRect();
        openPortal(sourceMenu, { clientX: rect.right, clientY: rect.bottom, trigger });
      });
      trigger?.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        trigger.click();
      });
    });
  }

  #syncPresentation() {
    const now = Date.now();
    for (const element of this.element?.querySelectorAll?.("[data-poker-effect]") ?? []) {
      const effect = this._presentation.effect(element.dataset.pokerEffect, now);
      if (!effect) {
        element.classList.remove("is-dealing", "is-animated");
        continue;
      }
      element.style.setProperty("--effect-delay", `${effect.delay}ms`);
      element.style.setProperty("--effect-duration", `${effect.duration}ms`);
    }
    positionCardOrigins(this.element);
    if (!this._resizeObserver && globalThis.ResizeObserver && this.element) {
      this._resizeObserver = new ResizeObserver(() => positionCardOrigins(this.element));
      this._resizeObserver.observe(this.element);
    }
    clearTimeout(this._resultRenderTimer);
    const remaining = this._presentation.resultAt - now;
    if (remaining > 0) this._resultRenderTimer = setTimeout(() => this.render(), remaining + 1);
  }

  #playPendingSounds() {
    for (const event of this._pendingSoundEvents.splice(0)) {
      const signal = event.turn ? this._turnSoundController.signal : this._soundController.signal;
      PokerSoundService.playSequence(event.id, 1, 0, Math.max(0, event.at - Date.now()), signal);
    }
  }

  async _onClose(options) {
    clearInterval(this._countdownTimer);
    this._soundController.abort();
    this._pendingSoundEvents = [];
    this._turnSoundController.abort();
    clearTimeout(this._resultRenderTimer);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._presentation = new TablePresentation();
    this._motionPreference?.removeEventListener("change", this._motionChanged);
    this._dismissContextMenu?.();
    this._dismissContextMenu = null;
    Hooks.off("fblPokerStateUpdated", this._stateHook);
    Hooks.off("fblPokerPrivateUpdated", this._privateHook);
    await super._onClose(options);
  }

  static joinSeat(_event, target) {
    new SeatDialogApp({ tableId: this.tableId, seatIndex: Number(target.dataset.seatIndex) }).render({ force: true });
  }

  static async cashOut(_event, target) {
    const expected = getPokerSocket().expectedState(this.tableId);
    try {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "FBLPoker.CashOut.Title" },
        content: `<p>${game.i18n.localize("FBLPoker.CashOut.Confirm")}</p>`,
        modal: true
      });
      if (!confirmed) return;
      await getPokerSocket().request(REQUEST.CASH_OUT, {
        expected,
        tableId: this.tableId,
        seatIndex: Number(target.dataset.seatIndex)
      });
    } catch (error) {
      notifyError(error);
    }
  }

  static openTopUp(_event, target) {
    new TopUpApp({ tableId: this.tableId, seatIndex: Number(target.dataset.seatIndex) }).render({ force: true });
  }

  static async toggleSitOut(_event, target) {
    try {
      const type = target.dataset.sittingOut === "true" ? REQUEST.SIT_IN : REQUEST.SIT_OUT;
      await getPokerSocket().request(type, {
        tableId: this.tableId,
        seatIndex: Number(target.dataset.seatIndex)
      });
    } catch (error) {
      notifyError(error);
    }
  }

  static async toggleSitOutAfterHand(_event, target) {
    try {
      await getPokerSocket().request(REQUEST.TOGGLE_SIT_OUT_AFTER_HAND, {
        tableId: this.tableId,
        seatIndex: Number(target.dataset.seatIndex)
      });
    } catch (error) {
      notifyError(error);
    }
  }

  static async toggleLeaveAfterHand(_event, target) {
    try {
      await getPokerSocket().request(REQUEST.TOGGLE_LEAVE_AFTER_HAND, {
        tableId: this.tableId,
        seatIndex: Number(target.dataset.seatIndex)
      });
    } catch (error) {
      notifyError(error);
    }
  }

  static async pokerAction(_event, target) {
    if (this._actionPending || !this._renderedAction?.expected) return;
    this._actionPending = true;
    this.element?.querySelectorAll?.('[data-action="pokerAction"]').forEach((button) => { button.disabled = true; });
    const rendered = this._renderedAction;
    try {
      const action = target.dataset.actionType;
      const amount = action === ACTIONS.BET || action === ACTIONS.RAISE
        ? parseStrictInteger(this.element.querySelector('[name="raiseAmount"]')?.value, "FBLPoker.Errors.InvalidBet")
        : null;
      await getPokerSocket().request(REQUEST.ACTION, {
        tableId: this.tableId,
        expected: rendered.expected,
        seatIndex: rendered.seatIndex,
        action,
        amount
      });
    } catch (error) {
      notifyError(error);
    } finally { this._actionPending = false; this.render(); }
  }

  static quickAmount(_event, target) {
    const numberInput = this.element.querySelector('[name="raiseAmount"]');
    const rangeInput = this.element.querySelector('[name="raiseRange"]');
    if (numberInput) numberInput.value = target.dataset.amount;
    if (rangeInput) rangeInput.value = target.dataset.amount;
    if (this._raiseDraft) this._raiseDraft.value = target.dataset.amount;
  }

  static async toggleCards(_event, target) {
    try {
      await getPokerSocket().request(REQUEST.SET_CARDS_REVEALED, {
        tableId: this.tableId,
        seatIndex: Number(target.dataset.seatIndex),
        revealed: target.dataset.revealed !== "true"
      });
    } catch (error) {
      notifyError(error);
    }
  }

  static async startHand() {
    try {
      const table = getPokerSocket().getTable(this.tableId);
      const type = table.status === TABLE_STATUS.COMPLETE ? REQUEST.NEXT_HAND : REQUEST.START_HAND;
      await getPokerSocket().request(type, { tableId: this.tableId });
    } catch (error) {
      notifyError(error);
    }
  }

  static async togglePause() {
    try {
      const table = getPokerSocket().getTable(this.tableId);
      const type = table.paused ? REQUEST.RESUME_TABLE : REQUEST.PAUSE_TABLE;
      await getPokerSocket().request(type, { tableId: this.tableId });
    } catch (error) {
      notifyError(error);
    }
  }

  static async forceReset() {
    const expected = getPokerSocket().expectedState(this.tableId);
    try {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "FBLPoker.Reset.Title" },
        content: `<p>${game.i18n.localize("FBLPoker.Reset.Confirm")}</p>`,
        modal: true
      });
      if (confirmed) await getPokerSocket().request(REQUEST.FORCE_RESET, { tableId: this.tableId, expected });
    } catch (error) {
      notifyError(error);
    }
  }

  static editTable() {
    new TableSettingsApp({ tableId: this.tableId }).render({ force: true });
  }

  static openHistory() {
    new PokerHistoryApp({ tableId: this.tableId }).render({ force: true });
  }

  static async toggleAutoNext() {
    try {
      const table = getPokerSocket().getTable(this.tableId);
      await getPokerSocket().request(REQUEST.SET_AUTO_NEXT, { tableId: this.tableId, enabled: !table.autoNextHand });
    } catch (error) {
      notifyError(error);
    }
  }

  static openSoundSettings() {
    if (!game.user.isGM) return;
    new PokerSoundSettingsApp().render({ force: true });
  }

  static async reconcile() {
    if (!game.user.isGM) return;
    try {
      await getPokerSocket().request(REQUEST.REQUEST_STATE);
      const pending = Object.values(game.settings.get(MODULE_ID, "moneyJournal") ?? {}).filter((entry) => entry.tableId === this.tableId && entry.status === "pending");
      if (!pending.length) { ui.notifications?.info(game.i18n.localize("FBLPoker.Recovery.Reload")); return; }
      for (const entry of pending) {
        const actor = game.actors.get(entry.actorId);
        const content = `<p>${escapeHtml(game.i18n.localize("FBLPoker.Recovery.Instructions"))}</p><p>${escapeHtml(actor?.name ?? entry.actorId)} · ${escapeHtml(entry.reason)}<br>${entry.beforeCopper} → ${entry.afterCopper}<br><code>${escapeHtml(entry.id)}</code></p>`;
        const applied = await foundry.applications.api.DialogV2.wait({
          window: { title: "FBLPoker.Recovery.Title" }, content, modal: true, rejectClose: false,
          buttons: [
            { action: "applied", label: game.i18n.localize("FBLPoker.Recovery.Applied"), callback: () => true },
            { action: "notApplied", label: game.i18n.localize("FBLPoker.Recovery.NotApplied"), callback: () => false },
            { action: "cancel", label: game.i18n.localize("FBLPoker.Recovery.Cancel"), default: true, callback: () => null }
          ]
        });
        if (typeof applied !== "boolean") return;
        await getPokerSocket().request(REQUEST.RESOLVE_MONEY, { operationId: entry.id, applied });
      }
    } catch (error) { notifyError(error); }
  }

  static async refresh() {
    try {
      await getPokerSocket().request(REQUEST.REQUEST_STATE);
    } catch (error) {
      notifyError(error);
    }
  }

  static toggleLog() {
    this.logCollapsed = !this.logCollapsed;
    this.render();
  }
}
