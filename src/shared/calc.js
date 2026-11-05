/* 工时打卡 —— 纯计算核心（无 DOM、无 Node 依赖，主进程与渲染进程共用） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_MS = 24 * 3600 * 1000;
  var HOUR_MS = 3600 * 1000;
  var MIN_MS = 60 * 1000;
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function parseLocal(s) {
    if (typeof s !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = m[6] ? +m[6] : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    var dt = new Date(y, mo - 1, d, h, mi, se, 0);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d ||
        dt.getHours() !== h || dt.getMinutes() !== mi || dt.getSeconds() !== se) return null;
    return dt;
  }

  function toLocalIso(dt) {
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()) +
      'T' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes()) + ':' + pad2(dt.getSeconds());
  }

  function dateKey(dt) {
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
  }

  /**
   * 计时归整：不足半小时按最近的小时取。
   * 分钟 0–29 → 当前整点；31–59 → 下一整点；
   * 正好 30 分整（含 0 秒 0 毫秒）视为“端口”，保留 30 分按实际时间计算。
   * 半点但带秒/毫秒（如 10:30:01）按“超过半点”处理 → 下一整点。
   */
  function roundPunchMs(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return ms;
    var dt = new Date(ms);
    var mi = dt.getMinutes();
    var leftover = mi === 30 && dt.getSeconds() === 0 && dt.getMilliseconds() === 0;
    if (leftover) return ms;
    var base = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours(), 0, 0, 0).getTime();
    return mi < 30 ? base : base + HOUR_MS;
  }

  function roundPunchDate(dt) {
    return new Date(roundPunchMs(dt.getTime()));
  }

  function monthKeyOf(dayKey) {
    return String(dayKey || '').slice(0, 7);
  }

  function parseDayKey(dayKey) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
    if (!m) return null;
    var dt = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
    if (dateKey(dt) !== dayKey) return null;
    return dt;
  }

  function addDays(dayKey, n) {
    var dt = parseDayKey(dayKey);
    if (!dt) return null;
    dt.setDate(dt.getDate() + n);
    return dateKey(dt);
  }

  function monthDays(monthKey) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
    if (!m) return [];
    var y = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12) return [];
    var days = [];
    var d = new Date(y, mo - 1, 1);
    while (d.getMonth() === mo - 1) {
      days.push(dateKey(d));
      d.setDate(d.getDate() + 1);
    }
    return days;
  }

  function weekdayIndex(dayKey) {
    var dt = parseDayKey(dayKey);
    return dt ? dt.getDay() : -1;
  }

  function weekdayName(dayKey) {
    var i = weekdayIndex(dayKey);
    return i >= 0 ? WEEKDAYS[i] : '';
  }

  function isWeekend(dayKey) {
    var i = weekdayIndex(dayKey);
    return i === 0 || i === 6;
  }

  function entryIsOpen(entry) {
    return !entry || entry.endAt == null;
  }

  function entryStartMs(entry) {
    var dt = entry ? parseLocal(entry.startAt) : null;
    return dt ? dt.getTime() : null;
  }

  function entryEndMs(entry, nowMs) {
    if (!entry) return null;
    if (entry.endAt == null) return typeof nowMs === 'number' ? roundPunchMs(nowMs) : null;
    var dt = parseLocal(entry.endAt);
    return dt ? dt.getTime() : null;
  }

  function entryDurationMs(entry, nowMs) {
    var s = entryStartMs(entry);
    if (s == null) return 0;
    var e = entryEndMs(entry, nowMs);
    if (e == null) return 0;
    var ms = e - s;
    return ms > 0 ? ms : 0;
  }

  function entryDayKey(entry) {
    var s = entryStartMs(entry);
    if (s == null) return null;
    return dateKey(new Date(s));
  }

  function sortEntries(entries) {
    return (entries || []).slice().sort(function (a, b) {
      return (entryStartMs(a) || 0) - (entryStartMs(b) || 0);
    });
  }

  function entriesForDay(entries, dayKey) {
    return sortEntries((entries || []).filter(function (e) {
      return entryDayKey(e) === dayKey;
    }));
  }

  function dayTotalMs(entries, dayKey, nowMs) {
    var total = 0;
    (entries || []).forEach(function (e) {
      if (entryDayKey(e) === dayKey) total += entryDurationMs(e, nowMs);
    });
    return total;
  }

  function openEntry(entries) {
    var open = (entries || []).filter(function (e) { return e && e.endAt == null; });
    if (!open.length) return null;
    return sortEntries(open)[open.length - 1];
  }

  function isStaleOpen(entry, nowMs, thresholdMs) {
    if (!entry || entry.endAt != null) return false;
    var s = entryStartMs(entry);
    if (s == null) return false;
    var limit = thresholdMs == null ? 16 * HOUR_MS : thresholdMs;
    return (nowMs - s) > limit;
  }

  function normalizeRates(rates) {
    var list = (rates || []).filter(function (r) {
      return r && typeof r.effectiveFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.effectiveFrom) &&
        typeof r.rate === 'number' && isFinite(r.rate) && r.rate > 0;
    }).map(function (r) {
      return { id: r.id, effectiveFrom: r.effectiveFrom, rate: r.rate };
    });
    list.sort(function (a, b) { return a.effectiveFrom < b.effectiveFrom ? -1 : (a.effectiveFrom > b.effectiveFrom ? 1 : 0); });
    return list;
  }

  function rateForDay(rates, dayKey) {
    var list = normalizeRates(rates);
    if (!list.length) return null;
    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].effectiveFrom <= dayKey) found = list[i];
      else break;
    }
    if (found) return { rate: found.rate, effectiveFrom: found.effectiveFrom, fallback: false };
    var first = list[0];
    return { rate: first.rate, effectiveFrom: first.effectiveFrom, fallback: true };
  }

  function moneyRound(x) {
    if (typeof x !== 'number' || !isFinite(x)) return 0;
    var sign = x < 0 ? -1 : 1;
    return sign * Math.round((Math.abs(x) + 1e-9) * 100) / 100;
  }

  function dayEarningsExact(ms, rate) {
    if (typeof ms !== 'number' || typeof rate !== 'number' || !isFinite(rate)) return null;
    return (ms / HOUR_MS) * rate;
  }

  function monthSummary(entries, rates, monthKey, nowMs) {
    var days = monthDays(monthKey);
    var byDay = {};
    (entries || []).forEach(function (e) {
      var dk = entryDayKey(e);
      if (!dk || monthKeyOf(dk) !== monthKey) return;
      (byDay[dk] = byDay[dk] || []).push(e);
    });
    var totalMs = 0;
    var earningsSum = 0;
    var hasRate = true;
    var daysWorked = 0;
    var hasOpen = false;
    var distinctRates = [];
    var rateFallback = false;
    var perDay = days.map(function (day) {
      var list = sortEntries(byDay[day] || []);
      var ms = list.reduce(function (acc, e) { return acc + entryDurationMs(e, nowMs); }, 0);
      var info = rateForDay(rates, day);
      var exact = info ? dayEarningsExact(ms, info.rate) : null;
      if (info && info.fallback) rateFallback = true;
      if (exact == null) hasRate = false; else earningsSum += exact;
      if (ms > 0) {
        daysWorked++;
        if (info && distinctRates.indexOf(info.rate) < 0) distinctRates.push(info.rate);
      }
      if (list.some(function (e) { return e.endAt == null; })) hasOpen = true;
      totalMs += ms;
      return {
        day: day,
        weekday: weekdayName(day),
        isWeekend: isWeekend(day),
        entries: list,
        ms: ms,
        rate: info ? info.rate : null,
        rateEffectiveFrom: info ? info.effectiveFrom : null,
        rateFallback: info ? info.fallback : false,
        earningsExact: exact,
        earnings: exact == null ? null : moneyRound(exact)
      };
    });
    return {
      monthKey: monthKey,
      days: days,
      perDay: perDay,
      totalMs: totalMs,
      totalEarnings: hasRate ? moneyRound(earningsSum) : null,
      totalEarningsExact: hasRate ? earningsSum : null,
      daysWorked: daysWorked,
      averageMs: daysWorked ? totalMs / daysWorked : 0,
      hasOpen: hasOpen,
      rateFallback: rateFallback,
      distinctRates: distinctRates
    };
  }

  function validateEntryInput(input, options) {
    var date = input && input.date;
    var startTime = input && input.startTime;
    var endTime = input && input.endTime;
    var nextDay = !!(input && input.nextDay);
    var doRound = !!(options && options.round);
    if (!parseDayKey(date)) return { ok: false, error: '请选择正确的日期' };
    if (!/^\d{2}:\d{2}$/.test(startTime || '') || !/^\d{2}:\d{2}$/.test(endTime || '')) {
      return { ok: false, error: '请填写正确的上下班时间（HH:mm）' };
    }
    var s = parseLocal(date + 'T' + startTime + ':00');
    var e = parseLocal(date + 'T' + endTime + ':00');
    if (!s || !e) return { ok: false, error: '时间格式不正确' };
    if (nextDay) {
      e = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1,
        e.getHours(), e.getMinutes(), e.getSeconds());
    }
    var rawMs = e.getTime() - s.getTime();
    if (rawMs > MAX_MS) return { ok: false, error: '单段工时不能超过 24 小时' };
    if (doRound) {
      s = roundPunchDate(s);
      e = roundPunchDate(e);
    }
    var ms = e.getTime() - s.getTime();
    if (ms <= 0) {
      return {
        ok: false,
        error: doRound
          ? '按整点归整后，下班时间不晚于上班时间，请调整时间（正好半点会按实际时间计算）'
          : '下班时间必须晚于上班时间（跨夜请勾选“次日”）'
      };
    }
    if (ms > MAX_MS) return { ok: false, error: '单段工时不能超过 24 小时' };
    return { ok: true, startAt: toLocalIso(s), endAt: toLocalIso(e), durationMs: ms };
  }

  function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && aEnd > bStart;
  }

  function findOverlap(entries, startAt, endAt, excludeId) {
    var s = parseLocal(startAt), e = parseLocal(endAt);
    if (!s || !e) return null;
    var list = sortEntries(entries || []);
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (excludeId && it.id === excludeId) continue;
      var is = entryStartMs(it), ie = entryEndMs(it);
      if (is == null || ie == null) continue;
      if (intervalsOverlap(s.getTime(), e.getTime(), is, ie)) return it;
    }
    return null;
  }

  function validateRateValue(rate) {
    if (typeof rate !== 'number' || !isFinite(rate)) return '请填写时薪金额';
    if (rate <= 0) return '时薪必须大于 0';
    if (rate > 10000) return '时薪不能超过 10000 元';
    if (Math.round(rate * 100) !== rate * 100) return '时薪最多保留两位小数';
    return null;
  }

  function formatDuration(ms) {
    var totalMin = Math.floor((ms || 0) / MIN_MS);
    if (totalMin <= 0) return ms > 0 ? '不足1分钟' : '0分钟';
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h && m) return h + '小时' + m + '分';
    if (h) return h + '小时';
    return m + '分';
  }

  function formatHoursShort(ms) {
    if (!ms) return '';
    var h = ms / HOUR_MS;
    if (h < 1) return Math.round(ms / MIN_MS) + '分';
    return (Math.round(h * 10) / 10).toString() + 'h';
  }

  function formatHoursDecimal(ms) {
    return Math.round((ms || 0) / HOUR_MS * 100) / 100;
  }

  function formatMoney(n) {
    if (n == null || typeof n !== 'number' || !isFinite(n)) return '—';
    var fixed = n.toFixed(2);
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '¥' + parts.join('.');
  }

  function formatTimeOfDay(iso) {
    var dt = parseLocal(iso);
    if (!dt) return '--:--';
    return pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }

  function formatRange(entry) {
    var start = formatTimeOfDay(entry.startAt);
    var end = entry.endAt == null ? '进行中' : formatTimeOfDay(entry.endAt);
    var next = '';
    if (entry.endAt != null) {
      var dk = entryDayKey(entry);
      var e = parseLocal(entry.endAt);
      if (e && dateKey(e) !== dk) next = '（次日）';
    }
    return start + '–' + end + next;
  }

  return {
    MAX_MS: MAX_MS,
    HOUR_MS: HOUR_MS,
    MIN_MS: MIN_MS,
    WEEKDAYS: WEEKDAYS,
    pad2: pad2,
    parseLocal: parseLocal,
    toLocalIso: toLocalIso,
    roundPunchMs: roundPunchMs,
    roundPunchDate: roundPunchDate,
    dateKey: dateKey,
    monthKeyOf: monthKeyOf,
    parseDayKey: parseDayKey,
    addDays: addDays,
    monthDays: monthDays,
    weekdayIndex: weekdayIndex,
    weekdayName: weekdayName,
    isWeekend: isWeekend,
    entryIsOpen: entryIsOpen,
    entryStartMs: entryStartMs,
    entryEndMs: entryEndMs,
    entryDurationMs: entryDurationMs,
    entryDayKey: entryDayKey,
    sortEntries: sortEntries,
    entriesForDay: entriesForDay,
    dayTotalMs: dayTotalMs,
    openEntry: openEntry,
    isStaleOpen: isStaleOpen,
    normalizeRates: normalizeRates,
    rateForDay: rateForDay,
    moneyRound: moneyRound,
    dayEarningsExact: dayEarningsExact,
    monthSummary: monthSummary,
    validateEntryInput: validateEntryInput,
    intervalsOverlap: intervalsOverlap,
    findOverlap: findOverlap,
    validateRateValue: validateRateValue,
    formatDuration: formatDuration,
    formatHoursShort: formatHoursShort,
    formatHoursDecimal: formatHoursDecimal,
    formatMoney: formatMoney,
    formatTimeOfDay: formatTimeOfDay,
    formatRange: formatRange
  };
});