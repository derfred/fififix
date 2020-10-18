import fetch from 'node-fetch';
import htmlparser from 'node-html-parser';
const { parse } = htmlparser;
import googleapis from 'googleapis';
const { google } = googleapis;
import googleauth from 'google-auth-library';
const { GoogleAuth } = googleauth;
import { v4 as uuidv4 } from 'uuid';

const BASEURL      = "https://book.timify.com";
const CLIENTSCOPES = ['https://www.googleapis.com/auth/spreadsheets']

const CO_PRENZLBERG = "5eb987c908eed811feb259d6"
const FIELDS = {}
FIELDS[CO_PRENZLBERG] = {
  firstname: "5eb987c908eed811feb259e3",
  lastname:  "5eb987c908eed811feb259e1",
  email:     "5eb987c908eed811feb259eb",
  phone:     "5eb987c908eed811feb259e4"
}

const COURSEQUERY = {
  opName: "getOnlineData",
  query:  `query getOnlineData($params: OnlineParams!, $sessionId: ID, $metadata: Dynamic) {
    getOnlineData(params: $params, sessionId: $sessionId, metadata: $metadata) {
      companies {
        courses {
          id
          name
          description
          duration
          durationsPattern
          maxParticipants
          extraPersonsPerParticipant
        }
      }
    }
  }`
};

const AVAILABLEQUERY = {
  opName: "getOnlineCourseAvailability",
  query:  `query getOnlineCourseAvailability($params: OnlineCourseAvailabilityParams!, $timezone: Timezone, $sessionId: ID, $metadata: Dynamic) {
    getOnlineCourseAvailability(params: $params, timezone: $timezone, sessionId: $sessionId, metadata: $metadata) {
      events {
        id
        title
        day
        time
        maxParticipants
        spotsLeft
        participantsCount
        duration
        currentBookerPresent
      }
    }
  }`
}

const RESERVEQUERY = {
  opName: "reserveOnlineCourse",
  query: `mutation reserveOnlineCourse($params: OnlineCourseReservationParams!, $sessionId: ID, $metadata: Dynamic) {
    reserveOnlineCourse(params: $params, sessionId: $sessionId, metadata: $metadata) {
      companyId
      eventId
      secret
    }
  }`
}

const FINALIZEQUERY = {
  opName: "finaliseOnlineCourseEventReservation",
  query:  `mutation finaliseOnlineCourseEventReservation($event: EventCourseReservationPayload!, $sessionId: ID, $metadata: Dynamic, $externalCustomerId: ID) {
    finaliseOnlineCourseEventReservation(event: $event, sessionId: $sessionId, metadata: $metadata, externalCustomerId: $externalCustomerId) {
      id
    }
  }`
}

function jsextract(needle, text) {
  const start = text.indexOf(needle);
  const mid   = text.substring(start, start+30).replace(`${needle}:`, "");
  const end   = mid.indexOf(",")
  return JSON.parse(mid.substring(0, end))
}

function btoa(obj) {
  return Buffer.from(JSON.stringify(obj).toString(), 'binary').toString('base64');
}

async function getAuth() {
  const auth = new GoogleAuth({
    keyFile: './auth/fififix-7e2b0667f9c8.json',
    scopes: CLIENTSCOPES,
  });
  return await auth.getClient();
}

const DAYS = {
  "mo": 1,
  "di": 2,
  "mi": 3,
  "do": 4,
  "fr": 5,
  "sa": 6,
  "so": 7,
}

function formatDate(date) {
  var d = new Date(date),
      month = '' + (d.getMonth() + 1),
      day = '' + d.getDate(),
      year = d.getFullYear();

  if (month.length < 2) 
      month = '0' + month;
  if (day.length < 2) 
      day = '0' + day;

  return [year, month, day].join('-');
}

function getTaskDate(title) {
  const parts = title.split(" ");
  const date  = new Date();
  date.setDate(date.getDate() + (7 + DAYS[parts[0].toLowerCase()] - date.getDay()) % 7);

  const times = parts[1].split(":")
  date.setHours(parseInt(times[0]))
  date.setMinutes(parseInt(times[1]))

  return date;
}

async function pullTasklist(spreadsheetId) {
  const auth = await getAuth();

  const sheets = google.sheets('v4');
  const book   = await sheets.spreadsheets.get({
    spreadsheetId,
    auth,
  });

  const result = []
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 2);
  cutoff.setHours(23)
  cutoff.setMinutes(1)

  for (const sheet of book.data.sheets) {
    const parts = sheet.properties.title.split(" ");
    const date  = getTaskDate(sheet.properties.title);

    if (date < cutoff) {
      const task  = {
        sheetId:   spreadsheetId,
        sheetName: sheet.properties.title,
        day:       parts[0],
        date:      formatDate(date),
        time:      parts[1],
        name:      parts.slice(2).join(" ").toLowerCase(),
        athletes:  []
      }
      const values = await sheets.spreadsheets.values.get({
        spreadsheetId,
        auth,
        range: sheet.properties.title
      });
      values.data.values.slice(1).forEach((row, i) => {
        if (row[0] != "x") {
          task.athletes.push({
            index:     i+1,
            firstname: row[1],
            lastname:  row[2],
            email:     row[3],
            phone:     row[4]
          })
        }
      });
      if (task.athletes.length > 0) {
        result.push(task)
      }
    }
  }
  return result;
}

class Fetcher {
  constructor(company) {
    this.company = company;
    this.session = this.newSession();
  }

  newSession() {
    return uuidv4()
  }

  async setup() {
    const page  = parse(await (await fetch(`${BASEURL}?accountId=${this.company}`)).text());
    const jsurl = page.querySelectorAll("script").find(e => e.getAttribute("src")?.startsWith("/static/js/2.")).getAttribute("src")
    const js    = await (await fetch(`${BASEURL}${jsurl}`)).text();

    this.headers = {
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.9,de;q=0.8",
      "content-type": "application/json",
      "p_i": btoa({ p_n: jsextract("REACT_APP_VERSION_SUFFIX", js), p_v: jsextract("REACT_APP_VERSION", js) }),
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site"
    }
  }

  async fetch(query, params, session) {
    const variables = {
      params: { companyId: this.company, ...params },
      sessionId: session || this.session
    }
    return await this.request(query, variables)
  }

  async request(query, variables) {
    const body = {
      variables,
      query:         query.query,
      operationName: query.opName
    }

    const result = await fetch("https://api-public.timify.io/", {
      headers:        this.headers,
      referrer:       "https://book.timify.com/",
      referrerPolicy: "strict-origin-when-cross-origin",
      method:         "POST",
      mode:           "cors",
      body:           JSON.stringify(body),
    });

    const response = await result.text();
    return JSON.parse(response);
  }

  async placeAthlete(athlete, eventId, secret, session) {
    const fids  = FIELDS[this.company];
    const event = {
      companyId: this.company,
      region:    "EUROPE",
      eventId:   eventId,
      secret,
      fields: [
        { id: fids.firstname, type: "TEXT",  value: athlete.firstname },
        { id: fids.lastname,  type: "TEXT",  value: athlete.lastname },
        { id: fids.email,     type: "EMAIL", value: athlete.email },
        { id: fids.phone,     type: "PHONE", value: JSON.stringify({ number: athlete.phone, country: "DE" }) }
      ]
    }
    const result = (await this.request(FINALIZEQUERY, { event }, session))
    if (result.errors) {
      throw new Error(`API Error: ${result.errors[0].message}`)
    }
    return result.data.finaliseOnlineCourseEventReservation.id;
  }
}

function continueTrying(tasks) {
  return tasks.length > 0;
}

function nextThreeDays() {
  const result = []
  const date   = new Date();
  result.push(formatDate(date))
  date.setDate(date.getDate() + 1)
  result.push(formatDate(date))
  date.setDate(date.getDate() + 1)
  result.push(formatDate(date))
  return result;
}

function courseAndTaskMatch(course, task) {
  return course.name.toLowerCase() == task.name;
}

function courseAndEventMatch(event, task) {
  return event.day === task.date && event.time === task.time;
}

async function retryThen(times, op) {
  const fails = [];
  while (times > 0) {
    try {
      const result = await op();
      return { success: true, result }
    } catch (error) {
      times--;
      fails.push(error)
    }
  }
  return { success: false, fails }
}

async function placeAthletes(fetcher, event, task) {
  const success = [];
  const failed  = [];
  for (const athlete of task.athletes) {
    const session = fetcher.newSession();
    const outcome = await retryThen(1, async function() {
      const reserve = (await fetcher.fetch(RESERVEQUERY, { region: "EUROPE", eventId: event.id }, session)).data;
      const secret = reserve.reserveOnlineCourse.secret;
      await fetcher.placeAthlete(athlete, event.id, secret, session);
      return `https://www.timify.com/de-de/cancel-booking/?eventId=${event.id}&secret=${secret}&accountId=${fetcher.company}&region=EUROPE`
    });
    if (outcome.success) {
      success.push({ ...athlete, reservation: outcome.result });
    } else {
      failed.push({ ...athlete, fails: outcome.fails });
    }
  }

  console.log(`${task.sheetName} success`, success)
  console.log(`${task.sheetName} failed`, failed)

  const tryWrite = async (auth, athlete, value) => {
    try {
      const sheets = google.sheets('v4');
      await sheets.spreadsheets.values.update({
        spreadsheetId:     task.sheetId,
        range:             `${task.sheetName}!F${athlete.index+1}`,
        valueInputOption: 'USER_ENTERED',
        resource:         { values: [[value]] },
        auth
      })
    } catch (error) {}
  }
  const auth = await getAuth();
  for (const athlete of success) {
    await tryWrite(auth, athlete, athlete.reservation)
  }
  for (const athlete of failed) {
    await tryWrite(auth, athlete, `Fehler ${athlete.fails}`)
  }
}

async function startPolling(fetcher, tasks) {
  const days    = nextThreeDays();
  const courses = (await fetcher.fetch(COURSEQUERY)).data.getOnlineData.companies[0].courses;
  for (const course of courses) {
    const taskIndex = tasks.findIndex(t => courseAndTaskMatch(course, t));
    if (taskIndex > -1) {
      const task   = tasks[taskIndex];
      const params = { courseId: course.id, days: days, region: "EUROPE" }
      const events = (await fetcher.fetch(AVAILABLEQUERY, params)).data.getOnlineCourseAvailability.events;
      const event  = events.find(e => courseAndEventMatch(e, task))

      if (event) {
        console.log("placing", task.sheetName)
        tasks.splice(taskIndex, 1);
        placeAthletes(fetcher, event, task);
      }
    }
  }
}

(async () => {
  const tasks   = await pullTasklist("15RH3oCfM05l86JMdiUqD_i8d_9vMB2ZXAPLOisDYg6o")
  const fetcher = new Fetcher(CO_PRENZLBERG);
  await fetcher.setup();

  while (continueTrying(tasks)) {
    await startPolling(fetcher, tasks);
  }
})();
