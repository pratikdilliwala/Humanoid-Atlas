// Atlas speaks up on his own: a meeting about to start, being stuck on an error, a long stretch without a break, and learned habits.
// At most one nudge every 15 minutes (meetings excepted); during calls, or in quiet mode, nudges are notifications only.
const brain = require('./brain'), tools = require('./tools');

// also catches TypeError, SyntaxError, NullPointerException and friends
const ERR = /(\w*error|\w*exception|failed|failure|traceback|not found|fatal|crash(ed)?)\b/i;
const CALL = /zoom|teams|google meet|meet\.google|discord|webex|skype|huddle/i;
const GAP = 15*60000;
let cur = null, activeSince = 0, lastNudge = 0;
const fired = new Set();

// one foreground sample from the window watcher, or { idle: true } after five idle minutes
function sample({ app = '', title = '', t = Date.now(), idle = false } = {}){
  if (idle){ cur = null; activeSince = 0; return; }
  if (!activeSince) activeSince = t;
  const key = app + '|' + title;
  if (!cur || cur.key !== key) cur = { key, app, title, since: t };
}

async function candidates(now, calendar, habits){
  const out = [], today = brain.day(new Date(now));
  try {
    const c = await calendar('today');
    for (const e of (c && c.events) || []){
      if (!/^\d{2}:\d{2}$/.test(e.time)) continue;
      const at = new Date(now); at.setHours(+e.time.slice(0, 2), +e.time.slice(3), 0, 0);
      const mins = (at - now)/60000;
      if (mins > 0 && mins <= 10) out.push({ id: `meet:${today}:${e.time}:${e.title}`, urgent: true,
        text: `"${e.title}" starts at ${e.time}, in ${Math.round(mins)} minutes${e.where ? ` (${e.where})` : ''}. Tell the user briefly.`,
        note: `${e.title} starts at ${e.time}${e.where ? ` · ${e.where}` : ''}` });
    }
  } catch (e) {}
  if (cur && ERR.test(cur.title) && now - cur.since >= 5*60000) out.push({ id: 'stuck:' + cur.key,
    text: `The user has had "${cur.title}" (${cur.app}) in front of them for ${Math.round((now - cur.since)/60000)} minutes and it looks like an error. Offer, in one sentence, to look at their screen and help. Call look_at_screen only if they agree.`,
    note: 'Stuck on an error? Ask me to look at your screen.' });
  if (activeSince && now - activeSince >= 90*60000) out.push({ id: 'break:' + activeSince,
    text: `The user has been working for ${Math.round((now - activeSince)/60000)} minutes without a break. Suggest a short break, warmly, in one sentence.`,
    note: 'You have been at it for a while. Time for a short break?' });
  for (const h of habits()) out.push({ id: `habit:${today}:${h.app}`, habit: h,
    text: `The user usually opens ${h.app} around ${brain.hhmm(h.minute)} and hasn't yet today. Offer briefly to open it; call open_app only if they say yes.`,
    note: `You usually open ${h.app} around ${brain.hhmm(h.minute)}. Click to open it.` });
  return out.filter(o => !fired.has(o.id));
}

// the nudge to give now, or null; { speak: false } means notify only
async function check({ now = Date.now(), quiet = false, calendar = tools.calendar, habits = brain.dueHabits } = {}){
  const list = await candidates(now, calendar, habits);
  const pick = list.find(o => o.urgent) || (now - lastNudge >= GAP ? list[0] : null);
  if (!pick) return null;
  fired.add(pick.id); lastNudge = now;
  if (pick.habit) brain.markOffered(pick.habit.app);
  const inCall = !!cur && CALL.test(cur.app + ' ' + cur.title);
  return { ...pick, speak: !quiet && !inCall };
}

function reset(){ cur = null; activeSince = 0; lastNudge = 0; fired.clear(); }

module.exports = { sample, check, reset };
