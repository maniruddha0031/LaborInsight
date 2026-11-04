/*
 * schemas.js — dataset types the engine understands, recognised by column signature.
 * File names are never trusted: a CSV is classified by which signature columns its header contains.
 *
 * Each field: canonical name -> list of accepted header aliases (normalised with util.hkey:
 * lower-case alphanumerics, '#' -> 'no'). `sig` columns must all be present for the type to match;
 * `req` columns must be present for the analysis that depends on the type to run.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});

  const common = {
    date: ['busidate', 'businessdate', 'busdate', 'date', 'workdate'],
    store: ['storeno', 'store', 'storeid', 'storenumber', 'storeno', 'site', 'siteid', 'location', 'locationid'],
    geid: ['geid', 'globalemployeeid', 'globalempid', 'globalid'],
    first: ['firstname', 'fname'],
    last: ['lastname', 'lname'],
    age: ['age'],
    timecard: ['timecard', 'timecardno', 'timecardnumber'],
    minorType: ['minortype', 'isminor', 'minor'],
    job: ['jobcode', 'job', 'jobtitle', 'position', 'role'],
    payrollId: ['payrollid', 'payrollno', 'payrollnumber'],
  };

  const T = {
    schedule: {
      label: 'Schedule',
      desc: 'Scheduled shifts and planned breaks per employee',
      sig: ['date', 'geid', 'start', 'end', 'schedHours'],
      req: ['date', 'store', 'geid', 'start', 'end'],
      fields: Object.assign({}, common, {
        jobDesc: ['jobcodedesc', 'jobdesc', 'jobcodedescription', 'activity'],
        start: ['starttime', 'shiftstart', 'start'],
        end: ['endtime', 'shiftend', 'end'],
        schedHours: ['schedulehours', 'scheduledhours', 'schhours', 'hours'],
        breakType: ['breaktype', 'segmenttype', 'type'],
      }),
    },
    punch: {
      label: 'Punches (timecards with pay)',
      desc: 'Final paid punches with hours, rates and pay',
      sig: ['geid', 'adjIn', 'adjOut', 'totalHrs'],
      req: ['date', 'store', 'geid', 'adjIn', 'adjOut', 'totalHrs'],
      fields: Object.assign({}, common, {
        payStart: ['payrollstartdate', 'paystartdate'],
        payEnd: ['payrollenddate', 'payenddate'],
        origIn: ['originalclockin', 'origclockin'],
        origOut: ['originalclockout', 'origclockout'],
        sourceId: ['sourceid', 'source', 'punchsource'],
        adjIn: ['adjustedclockin', 'clockin', 'punchin'],
        adjOut: ['adjustedclockout', 'clockout', 'punchout'],
        rate: ['payrate', 'rate', 'hourlyrate', 'wage'],
        otRate: ['otpayrate', 'overtimepayrate', 'otrate'],
        dtRate: ['dtpayrate', 'doubletimepayrate', 'dtrate'],
        regHrs: ['regularhours', 'reghours'],
        otHrs: ['overtimehours', 'othours'],
        dtHrs: ['doubletimehours', 'dthours'],
        breakHrs: ['totalbreakhours', 'breakhours'],
        totalHrs: ['totalpunchhours', 'totalhours', 'paidhours', 'workedhours'],
        normalPay: ['normalpay', 'regularpay'],
        otPay: ['otpay', 'overtimepay'],
        dtPay: ['dtpay', 'doubletimepay'],
        totalPay: ['totalpay', 'grosspay'],
      }),
    },
    punchAudit: {
      label: 'Punch audit log',
      desc: 'Every clock-in/out event with method, editor and timing',
      sig: ['geid', 'punchType', 'method', 'modifiedBy', 'origIn'],
      req: ['date', 'store', 'geid', 'punchType', 'method'],
      fields: Object.assign({}, common, {
        origIn: ['originalclockin'],
        origOut: ['originalclockout'],
        adjIn: ['adjustedclockin'],
        adjOut: ['adjustedclockout'],
        punchType: ['punchtype'],
        method: ['punchmethod', 'method'],
        isModified: ['ismodified'],
        modifiedAt: ['modifiedat', 'modifieddatetime'],
        modifiedBy: ['modifiedby', 'editor'],
        detail: ['adjustmentdetail', 'description', 'action'],
      }),
    },
    approval: {
      label: 'Punch change approvals',
      desc: 'Punch and break edits with original vs adjusted times and the editor',
      sig: ['geid', 'origStart', 'adjStart', 'description'],
      req: ['date', 'store', 'geid', 'description'],
      fields: Object.assign({}, common, {
        origStart: ['originalpunchstarttime'],
        origEnd: ['originalpunchendtime'],
        adjStart: ['adjustedpunchstarttime'],
        adjEnd: ['adjustedpunchendtime'],
        origBrkStart: ['originalbreakstarttime'],
        origBrkEnd: ['originalbreakendtime'],
        adjBrkStart: ['adjustedbreakstarttime'],
        adjBrkEnd: ['adjustedbreakendtime'],
        type: ['type', 'punchtype'],
        method: ['punchmethod', 'method'],
        modifiedAt: ['modifieddatetime', 'modifiedat'],
        editor: ['managermodified', 'modifiedby', 'editor'],
        description: ['description', 'adjustmentdetail'],
      }),
    },
    breaks: {
      label: 'Breaks',
      desc: 'Breaks taken, with type and duration',
      sig: ['geid', 'brkIn', 'breakType', 'totalBreak'],
      req: ['date', 'geid', 'brkIn', 'brkOut'],
      fields: Object.assign({}, common, {
        origIn: ['originalbreakin'],
        origOut: ['originalbreakout'],
        brkIn: ['adjustedbreakin', 'breakin', 'breakstart'],
        brkOut: ['adjustedbreakout', 'breakout', 'breakend'],
        breakType: ['breaktype'],
        totalBreak: ['totalbreakhours', 'breakhours', 'breakduration'],
      }),
    },
    breakAudit: {
      label: 'Break audit log',
      desc: 'Break start/end events with method and editor',
      sig: ['geid', 'brkIn', 'punchType', 'modifiedBy'],
      req: ['date', 'geid', 'punchType'],
      fields: Object.assign({}, common, {
        origIn: ['originalbreakin'],
        origOut: ['originalbreakout'],
        brkIn: ['adjustedbreakin'],
        brkOut: ['adjustedbreakout'],
        punchType: ['punchtype'],
        method: ['punchmethod'],
        isModified: ['ismodified'],
        modifiedAt: ['modifiedat'],
        modifiedBy: ['modifiedby'],
      }),
    },
    exception: {
      label: 'Labor exceptions',
      desc: 'Labor-law breaches flagged by the time clock and manager authorisation',
      sig: ['geid', 'breach', 'mgrAuth'],
      req: ['date', 'geid'],
      fields: Object.assign({}, common, {
        start: ['starttime'],
        end: ['endtime'],
        violationAt: ['datetimeofviolation', 'violationtime'],
        breach: ['typeofbreach', 'breachtype', 'violationtype'],
        mgrAuth: ['ismanagerauthorized', 'managerauthorized'],
        mgrName: ['managername'],
      }),
    },
    sales: {
      label: 'Forecast & actual sales / hours',
      desc: 'Store sales and labor-hour forecast vs actual (aggregated to month on load)',
      sig: ['store', 'fcstSales', 'actSales'],
      req: ['store', 'date', 'actSales'],
      fields: {
        store: ['store', 'storeno', 'storeid', 'site'],
        date: ['date', 'busidate', 'businessdate'],
        slot: ['slotindex'],
        fcstHours: ['forecastedhours', 'forecasthours'],
        schedHours: ['schedulehours', 'scheduledhours'],
        actHours: ['actualhours'],
        idealHours: ['idealhours'],
        fcstSales: ['forecastedsales', 'forecastsales'],
        actSales: ['actualsales', 'sales', 'netsales'],
        txn: ['transactioncount', 'transactions', 'tickets'],
      },
    },
    premiumPay: {
      label: 'Premium pay',
      desc: 'Violation premiums paid (e.g. meal-break premium)',
      sig: ['geid', 'amount'],
      req: ['date', 'geid', 'amount'],
      fields: Object.assign({}, common, { rate: ['payrate'], amount: ['premiumpay'] }),
    },
    miscPay: {
      label: 'Misc pay',
      desc: 'Other pay items (e.g. mileage)',
      sig: ['geid', 'amount'],
      req: ['date', 'geid', 'amount'],
      fields: Object.assign({}, common, { rate: ['payrate'], amount: ['miscpay'] }),
    },
  };

  /** Build header-index map for a type. Returns {map:{field:idx}, missingReq:[], unmapped:[]} */
  function mapHeader(type, header) {
    const keys = header.map(LCI.util.hkey);
    const def = T[type];
    const map = {};
    const used = new Set();
    for (const f in def.fields) {
      for (const a of def.fields[f]) {
        const i = keys.indexOf(a);
        if (i >= 0 && !used.has(i)) { map[f] = i; used.add(i); break; }
      }
    }
    const missingReq = def.req.filter((f) => map[f] === undefined);
    const unmapped = header.filter((h, i) => !used.has(i) && !/^s\s*no\.?$/i.test(String(h).trim()));
    return { map, missingReq, unmapped };
  }

  /** Classify a header row. Returns best type key or null. */
  function classify(header) {
    let best = null, bestScore = 0;
    for (const t in T) {
      const { map } = mapHeader(t, header);
      if (!T[t].sig.every((f) => map[f] !== undefined)) continue;
      // Prefer the type whose signature-specific columns explain the most of the header.
      const score = Object.keys(map).length + T[t].sig.length * 2;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    // premiumPay vs miscPay share a shape; disambiguate on the amount column name.
    if (best === 'premiumPay' || best === 'miscPay') {
      const keys = header.map(LCI.util.hkey);
      best = keys.includes('miscpay') ? 'miscPay' : keys.includes('premiumpay') ? 'premiumPay' : best;
    }
    return best;
  }

  LCI.schemas = { types: T, mapHeader, classify };
})(typeof globalThis !== 'undefined' ? globalThis : self);
