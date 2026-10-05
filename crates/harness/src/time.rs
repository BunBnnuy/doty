//! Minimal RFC 3339 / ISO 8601 UTC parser.
//!
//! Codex writes timestamps like `2026-10-02T19:19:27.098Z`. We deliberately do
//! not pull in a date crate: this is the only date maths the watcher needs.

use std::time::{SystemTime, UNIX_EPOCH};

/// Current wall-clock time in epoch milliseconds.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parse an RFC 3339 timestamp into epoch milliseconds (UTC).
///
/// Accepts `YYYY-MM-DDTHH:MM:SS`, an optional `.fff...` fraction, and an
/// optional `Z` / `+HH:MM` / `-HH:MM` offset. Returns `None` on anything else.
pub fn parse_rfc3339_millis(input: &str) -> Option<i64> {
    let input = input.trim();
    let (date, rest) = input.split_once(['T', 't'])?;

    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() {
        return None;
    }

    // Time zone suffix: `Z`, `+HH:MM`, `-HH:MM`, or nothing (assume UTC).
    let (time, offset_minutes) = split_offset(rest)?;

    let (hms, fraction) = match time.split_once('.') {
        Some((hms, frac)) => (hms, Some(frac)),
        None => (time, None),
    };
    let mut t = hms.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let minute: i64 = t.next()?.parse().ok()?;
    let second: i64 = t.next()?.parse().ok()?;
    if t.next().is_some() {
        return None;
    }

    let millis: i64 = match fraction {
        Some(frac) => {
            let digits: String = frac.chars().take(3).collect();
            let padded = format!("{digits:0<3}");
            padded.parse().ok()?
        }
        None => 0,
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

fn split_offset(rest: &str) -> Option<(&str, i64)> {
    if let Some(stripped) = rest.strip_suffix(['Z', 'z']) {
        return Some((stripped, 0));
    }
    // Look for a signed offset after the seconds.
    let sign_pos = rest.rfind(['+', '-'])?;
    let (time, offset) = rest.split_at(sign_pos);
    let sign = if offset.starts_with('-') { -1 } else { 1 };
    let mut parts = offset[1..].split(':');
    let oh: i64 = parts.next()?.parse().ok()?;
    let om: i64 = parts.next().unwrap_or("0").parse().ok()?;
    Some((time, sign * (oh * 60 + om)))
}

/// Days since the Unix epoch for a proleptic Gregorian date
/// (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_timestamp() {
        // 2026-10-02T19:19:27.098Z
        let got = parse_rfc3339_millis("2026-10-02T19:19:27.098Z").unwrap();
        // Cross-check with a known-good computation: 2026-10-02T00:00:00Z.
        let midnight = parse_rfc3339_millis("2026-10-02T00:00:00Z").unwrap();
        assert_eq!(got - midnight, (19 * 3600 + 19 * 60 + 27) * 1000 + 98);
    }

    #[test]
    fn parses_without_fraction_and_offsets() {
        assert_eq!(
            parse_rfc3339_millis("1970-01-01T00:00:00Z").unwrap(),
            0
        );
        assert_eq!(
            parse_rfc3339_millis("1970-01-01T01:00:00+01:00").unwrap(),
            0
        );
        assert_eq!(
            parse_rfc3339_millis("1970-01-01T00:00:00.5Z").unwrap(),
            500
        );
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_rfc3339_millis("not-a-date").is_none());
        assert!(parse_rfc3339_millis("2026-10-02").is_none());
    }
}
