import { ACTIONS, ACTIVE_STREETS, REQUEST, TABLE_STATUS } from "../constants.js";
import { PokerSoundService } from "../audio/sound-service.js";
import { cardDisplay } from "../engine/cards.js";
import { getPokerSocket } from "../runtime.js";
import { notifyError, parseStrictInteger } from "../util.js";
import { PokerHistoryApp } from "./history-app.js";
import { PokerSoundSettingsApp } from "./sound-settings-app.js";
import { SeatDialogApp } from "./seat-dialog-app.js";
import { TableSettingsApp } from "./table-settings-app.js";
import { TopUpApp } from "./top-up-app.js";
import { seatEllipsePosition } from "./table-geometry.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function actionLabel(action) {
  const key = `FBLPoker.Actions.${action}`;
  const localized = game.i18n.localize(key);
  return localized === key ? action : localized;
}

function cardView(card, hidden = false) {
  if (hidden) return { hidden: true, rank: "", symbol: "", red: false };
  return { ...cardDisplay(card), hidden: false };
}

function legalActions(table, seat) {
  if (table.paused || !seat || !ACTIVE_STREETS.has(table.status) || table.currentSeat !== seat.index || seat.folded || seat.allIn) return null;
  const callAmount = Math.max(0, table.currentBet - seat.streetBet);
  const maxTarget = seat.streetBet + seat.stack;
  const fullRaiseTarget = table.currentBet === 0
    ? table.bigBlind
    : (table.currentBet < table.bigBlind ? table.bigBlind : table.currentBet + table.lastFullRaise);
  const raiseAllowed = !table.raiseLocked.includes(seat.index) && maxTarget > table.currentBet;
  const minTarget = Math.min(maxTarget, fullRaiseTarget);
  const potAfterCall = table.potTotal + callAmount;
  const fractionTarget = (fraction) => {
    const target = table.currentBet === 0
      ? Math.round(table.potTotal * fraction)
      : table.currentBet + Math.round(potAfterCall * fraction);
    return Math.min(maxTarget, Math.max(minTarget, target));
  };
  return {
    callAmount: Math.min(callAmount, seat.stack),
    canCheck: callAmount === 0,
    canCall: callAmount > 0 && seat.stack > 0,
    canBet: table.currentBet === 0 && raiseAllowed,
    canRaise: table.currentBet > 0 && raiseAllowed,
    canAllIn: seat.stack > 0,
    minTarget,
    maxTarget,
    thirdPotTarget: fractionTarget(1 / 3),
    halfPotTarget: fractionTarget(1 / 2),
    threeQuarterPotTarget: fractionTarget(3 / 4),
    potTarget: fractionTarget(1),
    showRaiseControls: raiseAllowed
  };
}

function currentVisualSnapshot(table) {
  return {
    handNumber: table.handNumber,
    status: table.status,
    communityLength: table.community?.length ?? 0,
    potTotal: table.potTotal ?? 0,
    seatBets: (table.seats ?? []).map((seat) => seat ? `${seat.streetBet}:${seat.handCommitted}:${seat.stack}` : ""),
    currentSeat: table.currentSeat,
    latestLogId: table.log?.[0]?.id ?? null,
    latestLogType: table.log?.[0]?.type ?? null
  };
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
    this._stateHook = () => this.render();
    this._privateHook = (data) => {
      if (data.tableId !== this.tableId) return;
      const table = getPokerSocket().getTable(this.tableId);
      if (!table || table.handNumber !== data.handNumber) return;
      const animation = this._dealAnimation?.handNumber === data.handNumber ? this._dealAnimation : null;
      const remaining = animation ? Math.max(0, animation.duration - (Date.now() - animation.startedAt)) : 0;
      clearTimeout(this._privateRenderTimer);
      if (remaining > 0) {
        this._privateRenderTimer = setTimeout(() => this.render(), remaining + 20);
      } else {
        this.render();
      }
    };
    this._countdownTimer = null;
    this._visualSnapshot = null;
    this._pendingSoundEvents = [];
    this._dealAnimation = null;
    this._privateRenderTimer = null;
    this._dismissContextMenu = null;
    this.logCollapsed = false;
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
    if (!table) return { missing: true };

    const active = ACTIVE_STREETS.has(table.status);
    const previousVisual = this._visualSnapshot;
    const nextVisual = currentVisualSnapshot(table);
    const dealNewHand = Boolean(previousVisual && nextVisual.handNumber > previousVisual.handNumber && active);
    const newCommunityFrom = previousVisual?.handNumber === nextVisual.handNumber
      ? previousVisual.communityLength
      : nextVisual.communityLength;
    const potAnimated = Boolean(previousVisual && previousVisual.potTotal !== nextVisual.potTotal);
    const winningSeats = new Set((table.status === TABLE_STATUS.COMPLETE ? table.lastResult?.awards : [])?.map((award) => award.seatIndex) ?? []);
    const optionalRevealSeats = new Set(
      table.status === TABLE_STATUS.COMPLETE && table.lastResult?.type === "uncontested"
        ? (table.lastResult.awards ?? []).map((award) => award.seatIndex)
        : []
    );
    const inHandIndices = table.seats.filter((seat) => seat?.inHand).map((seat) => seat.index);
    const inHandSet = new Set(inHandIndices);
    const dealOrder = [];
    const dealerStart = Number.isInteger(table.dealerIndex) ? table.dealerIndex : -1;
    for (let step = 1; step <= table.maxSeats; step += 1) {
      const seatIndex = (dealerStart + step + table.maxSeats) % table.maxSeats;
      if (inHandSet.has(seatIndex)) dealOrder.push(seatIndex);
    }
    const dealOrderPosition = new Map(dealOrder.map((seatIndex, position) => [seatIndex, position]));
    const dealDuration = Math.max(700, dealOrder.length * 2 * 140 + 560);
    if (dealNewHand) {
      this._dealAnimation = { handNumber: table.handNumber, startedAt: Date.now(), duration: dealDuration };
    }
    const dealAnimation = this._dealAnimation?.handNumber === table.handNumber
      && (Date.now() - this._dealAnimation.startedAt) < this._dealAnimation.duration
      ? this._dealAnimation
      : null;
    const dealElapsed = dealAnimation ? Math.max(0, Date.now() - dealAnimation.startedAt) : 0;
    if (!dealAnimation) this._dealAnimation = null;
    this._pendingSoundEvents = this.#transitionSoundEvents(previousVisual, nextVisual, table, dealOrder.length);
    const socket = getPokerSocket();

    const seatViews = table.seats.map((seat, index) => {
      const { angle, left, top } = seatEllipsePosition(index, table.maxSeats);
      const dealX = Math.round((-Math.cos(angle) * 420) - 108);
      const dealY = Math.round((-Math.sin(angle) * 290) - 108);
      const style = `left:${left}%;top:${top}%;--deal-x:${dealX}px;--deal-y:${dealY}px`;
      if (!seat) return { index, empty: true, style, canJoin: !active };

      const automated = socket.isAutomatedSeat(table.id, index);
      const ownSeat = seat.userId === game.user.id && !automated;
      const privateCards = socket.getPrivateHand(table.id, table.handNumber, index);
      const visibleCards = seat.revealedCards?.length ? seat.revealedCards : (ownSeat ? privateCards : []);
      const rawCards = visibleCards.length
        ? visibleCards.map((card) => cardView(card))
        : Array.from({ length: seat.cardsCount || (seat.inHand ? 2 : 0) }, () => cardView(null, true));
      const dealPosition = dealOrderPosition.get(index) ?? 0;
      const cards = rawCards.map((card, cardIndex) => {
        const scheduledDelay = ((cardIndex * Math.max(1, dealOrder.length)) + dealPosition) * 140;
        return {
          ...card,
          animateDeal: Boolean(dealAnimation && seat.inHand),
          dealDelay: Math.max(0, scheduledDelay - dealElapsed)
        };
      });
      const canManage = ownSeat || game.user.isGM;
      const cardsRevealed = Boolean(seat.revealedCards?.length);
      const canToggleCards = canManage
        && table.status === TABLE_STATUS.COMPLETE
        && optionalRevealSeats.has(index)
        && seat.cardsCount > 0;
      const chipAnimated = Boolean(previousVisual && previousVisual.seatBets[index] !== nextVisual.seatBets[index]);

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
    const canActForSeat = actingSeat && !actingSeatAutomated && (actingSeat.userId === game.user.id || game.user.isGM);
    const legal = canActForSeat ? legalActions(table, actingSeat) : null;
    const eligibleCount = table.seats.filter((seat) => seat && !seat.sittingOut && !seat.leaveAfterHand && seat.stack > 0).length;

    const community = Array.from({ length: 5 }, (_, index) => {
      if (!table.community[index]) return { empty: true };
      return {
        ...cardView(table.community[index]),
        animateDeal: Boolean(previousVisual && index >= newCommunityFrom),
        dealDelay: Math.max(0, index - newCommunityFrom) * 100
      };
    });

    const logs = (table.log ?? []).slice(0, 35).map((entry) => {
      const seat = entry.seatIndex === null ? null : table.seats[entry.seatIndex];
      let text = game.i18n.localize(`FBLPoker.Log.${entry.type}`);
      if (text === `FBLPoker.Log.${entry.type}`) text = actionLabel(entry.type);
      return {
        id: entry.id,
        actorName: seat?.actorName ?? "",
        text,
        amount: typeof entry.amount === "number" ? entry.amount : null
      };
    });

    const awardTotals = new Map();
    for (const award of (table.status === TABLE_STATUS.COMPLETE ? table.lastResult?.awards : []) ?? []) {
      const current = awardTotals.get(award.seatIndex) ?? { seatIndex: award.seatIndex, amount: 0, categoryName: award.categoryName ?? null };
      current.amount += Number(award.amount) || 0;
      if (!current.categoryName && award.categoryName) current.categoryName = award.categoryName;
      awardTotals.set(award.seatIndex, current);
    }
    const resultAwards = [...awardTotals.values()].map((award) => ({
      ...award,
      actorName: table.seats[award.seatIndex]?.actorName ?? "?",
      categoryLabel: award.categoryName ? game.i18n.localize(`FBLPoker.Hands.${award.categoryName}`) : ""
    }));

    Object.assign(context, {
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
      hasResult: resultAwards.length > 0,
      historyCount: table.handHistory?.length ?? 0,
      logCollapsed: this.logCollapsed,
      deckDealing: Boolean(dealAnimation),
      deckDealDuration: dealAnimation ? Math.max(280, dealAnimation.duration - dealElapsed) : 500,
      autoNextWaiting: table.status === TABLE_STATUS.COMPLETE && table.autoNextHand && Boolean(table.nextHandDeadline),
      potAnimated
    });

    this._visualSnapshot = nextVisual;
    return context;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    Hooks.on("fblPokerStateUpdated", this._stateHook);
    Hooks.on("fblPokerPrivateUpdated", this._privateHook);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._syncWindowTitle();
    this.#renderHeaderButtons();
    this.#bindSeatContextMenus();
    this.#playPendingSounds();
    clearInterval(this._countdownTimer);

    const updateTimer = () => {
      const table = getPokerSocket().getTable(this.tableId);
      const timer = this.element?.querySelector?.("[data-turn-timer]");
      const autoNext = this.element?.querySelector?.("[data-auto-next-countdown]");
      if (autoNext) {
        const remaining = table?.nextHandDeadline ? Math.max(0, Math.ceil((table.nextHandDeadline - Date.now()) / 1000)) : 0;
        autoNext.textContent = String(remaining);
      }
      if (!timer) return;
      const secondsElement = timer.querySelector("[data-turn-timer-seconds]");
      const barElement = timer.querySelector("[data-turn-timer-bar]");
      if (!table?.turnDeadline || table.currentSeat === null || table.paused) {
        timer.classList.add("is-hidden");
        if (secondsElement) secondsElement.textContent = "–";
        if (barElement) {
          barElement.style.width = "0%";
          barElement.style.background = "hsl(0 72% 46%)";
        }
        return;
      }
      const totalMs = Math.max(1000, Number(table.actionSeconds || 0) * 1000);
      const remainingMs = Math.max(0, table.turnDeadline - Date.now());
      const ratio = Math.max(0, Math.min(1, remainingMs / totalMs));
      const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
      const hue = Math.round(ratio * 120);
      timer.classList.remove("is-hidden");
      if (secondsElement) secondsElement.textContent = String(seconds);
      if (barElement) {
        barElement.style.width = `${Math.max(2, ratio * 100)}%`;
        barElement.style.background = `hsl(${hue} 72% 46%)`;
      }
    };
    updateTimer();
    this._countdownTimer = setInterval(updateTimer, 250);

    const numberInput = this.element?.querySelector?.('[name="raiseAmount"]');
    const rangeInput = this.element?.querySelector?.('[name="raiseRange"]');
    if (numberInput && rangeInput) {
      const syncNumber = () => { numberInput.value = rangeInput.value; };
      const syncRange = () => { rangeInput.value = numberInput.value; };
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
    const eligibleCount = table.seats.filter((seat) => seat && !seat.sittingOut && !seat.leaveAfterHand && seat.stack > 0).length;
    const container = document.createElement("div");
    container.className = "fbl-poker-header-inline";

    const actions = [];
    if (game.user.isGM) {
      actions.push(
        {
          icon: "fa-solid fa-play",
          title: game.i18n.localize("FBLPoker.Table.StartHand"),
          disabled: active || eligibleCount < 2,
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

  #transitionSoundEvents(previous, next, table, dealSeatCount) {
    if (!previous) return [];
    const events = [];
    const newHand = next.handNumber > previous.handNumber && ACTIVE_STREETS.has(table.status);
    if (newHand) {
      const count = Math.max(0, dealSeatCount * 2);
      if (count) events.push({ id: "holeDeal", count, interval: 140, delay: 0 });
    } else if (next.handNumber === previous.handNumber && next.communityLength > previous.communityLength) {
      events.push({ id: "communityDeal", count: next.communityLength - previous.communityLength, interval: 120, delay: 0 });
    }

    const latestLog = table.log?.[0];
    if (latestLog?.id && latestLog.id !== previous.latestLogId) {
      if (["smallBlind", "bigBlind", "ante", "call", "bet", "raise"].includes(latestLog.type)) {
        events.push({ id: "chips", count: 1, delay: newHand ? Math.max(0, dealSeatCount * 280) : 0 });
      } else if (latestLog.type === "allIn") {
        events.push({ id: "allIn", count: 1, delay: 0 });
      } else if (latestLog.type === "fold") {
        events.push({ id: "fold", count: 1, delay: 0 });
      } else if (latestLog.type === "check") {
        events.push({ id: "check", count: 1, delay: 0 });
      }
    }

    if (previous.status !== TABLE_STATUS.COMPLETE && next.status === TABLE_STATUS.COMPLETE) {
      events.push({ id: "win", count: 1, delay: 220 });
    }

    if (next.currentSeat !== previous.currentSeat && next.currentSeat !== null) {
      const actingSeat = table.seats?.[next.currentSeat];
      const automated = getPokerSocket().isAutomatedSeat(table.id, next.currentSeat);
      if (actingSeat?.userId === game.user.id && !automated) {
        const delay = newHand ? Math.max(0, dealSeatCount * 280 + 180) : 80;
        events.push({ id: "turn", count: 1, delay });
      }
    }
    return events;
  }

  #playPendingSounds() {
    const events = this._pendingSoundEvents.splice(0);
    for (const event of events) {
      PokerSoundService.playSequence(event.id, event.count ?? 1, event.interval ?? 120, event.delay ?? 0);
    }
  }

  async _onClose(options) {
    clearInterval(this._countdownTimer);
    clearTimeout(this._privateRenderTimer);
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
    try {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "FBLPoker.CashOut.Title" },
        content: `<p>${game.i18n.localize("FBLPoker.CashOut.Confirm")}</p>`,
        modal: true
      });
      if (!confirmed) return;
      await getPokerSocket().request(REQUEST.CASH_OUT, {
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
    try {
      const action = target.dataset.actionType;
      const amount = action === ACTIONS.BET || action === ACTIONS.RAISE
        ? parseStrictInteger(this.element.querySelector('[name="raiseAmount"]')?.value, "FBLPoker.Errors.InvalidBet")
        : null;
      const table = getPokerSocket().getTable(this.tableId);
      await getPokerSocket().request(REQUEST.ACTION, {
        tableId: this.tableId,
        seatIndex: table.currentSeat,
        action,
        amount
      });
    } catch (error) {
      notifyError(error);
    }
  }

  static quickAmount(_event, target) {
    const numberInput = this.element.querySelector('[name="raiseAmount"]');
    const rangeInput = this.element.querySelector('[name="raiseRange"]');
    if (numberInput) numberInput.value = target.dataset.amount;
    if (rangeInput) rangeInput.value = target.dataset.amount;
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
    try {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "FBLPoker.Reset.Title" },
        content: `<p>${game.i18n.localize("FBLPoker.Reset.Confirm")}</p>`,
        modal: true
      });
      if (confirmed) await getPokerSocket().request(REQUEST.FORCE_RESET, { tableId: this.tableId });
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
