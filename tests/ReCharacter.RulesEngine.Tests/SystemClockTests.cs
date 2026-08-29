using System.Globalization;
using ReCharacter.RulesEngine;
using Xunit;

namespace ReCharacter.RulesEngine.Tests;

public class SystemClockTests
{
    // 11:00Z is midnight in UTC-11 (American Samoa), the westernmost inhabited U.S. zone. Any
    // instant before 11:00Z is still "yesterday" there, so the engine must also treat it as
    // yesterday: rolling the date early is the one way to tell a veteran a window closed while
    // it is in fact still open somewhere in the U.S.

    [Fact]
    public void TodayFor_At_1059Z_IsPreviousCivilDay()
    {
        var utcNow = new DateTimeOffset(2026, 3, 1, 10, 59, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 2, 28), SystemClock.TodayFor(utcNow));
    }

    [Fact]
    public void TodayFor_At_1100Z_IsSameCivilDay()
    {
        var utcNow = new DateTimeOffset(2026, 3, 1, 11, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 3, 1), SystemClock.TodayFor(utcNow));
    }

    [Fact]
    public void TodayFor_EarlyOnNewYearsDayUtc_IsLastDayOfPreviousYear()
    {
        var utcNow = new DateTimeOffset(2027, 1, 1, 5, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 12, 31), SystemClock.TodayFor(utcNow));
    }

    [Fact]
    public void TodayFor_EarlyOnMarchFirstUtcInLeapYear_IsFeb29()
    {
        var utcNow = new DateTimeOffset(2028, 3, 1, 10, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2028, 2, 29), SystemClock.TodayFor(utcNow));
    }

    [Theory]
    [InlineData("2026-03-01T02:00:00-09:00", 2026, 3, 1)]  // 11:00Z exactly -> same civil day
    [InlineData("2026-03-01T01:59:00-09:00", 2026, 2, 28)] // 10:59Z -> wall-clock date is Mar 1, answer is Feb 28
    [InlineData("2026-03-01T20:59:00+10:00", 2026, 2, 28)] // 10:59Z from a positive offset
    public void TodayFor_InputAtNonUtcOffset_UsesTheInstantNotItsWallClockDate(
        string input, int year, int month, int day)
    {
        var instant = DateTimeOffset.Parse(input, CultureInfo.InvariantCulture);

        Assert.Equal(new DateOnly(year, month, day), SystemClock.TodayFor(instant));
    }

    [Fact]
    public void Today_IsWithinOneDayOfUtcToday()
    {
        // Sanity check on the live property (no fixed clock). UTC-11 trails UTC, so Today is never
        // ahead of the UTC date and is at most one day behind it. Capture Today first so a UTC
        // midnight rollover between the two reads can only widen the gap in the allowed direction.
        var today = new SystemClock().Today;
        var utcToday = DateOnly.FromDateTime(DateTime.UtcNow);

        Assert.InRange(utcToday.DayNumber - today.DayNumber, 0, 1);
    }
}
