using ReCharacter.RulesEngine;
using Xunit;

namespace ReCharacter.RulesEngine.Tests;

public class DrbWindowTests
{
    [Fact]
    public void Deadline_IsExactlyFifteenYearsAfterDischarge()
    {
        var discharge = new DateOnly(2010, 3, 14);

        Assert.Equal(new DateOnly(2025, 3, 14), DrbWindow.Deadline(discharge));
    }

    [Fact]
    public void IsOpen_DayBeforeDeadline_True()
    {
        var discharge = new DateOnly(2010, 3, 14);
        var asOf = new DateOnly(2025, 3, 13); // one day before the 15-year mark

        Assert.True(DrbWindow.IsOpen(discharge, asOf));
    }

    [Fact]
    public void IsOpen_OnDeadlineDay_True_Inclusive()
    {
        var discharge = new DateOnly(2010, 3, 14);
        var asOf = new DateOnly(2025, 3, 14); // exactly 15 years later

        Assert.True(DrbWindow.IsOpen(discharge, asOf));
    }

    [Fact]
    public void IsOpen_DayAfterDeadline_False()
    {
        var discharge = new DateOnly(2010, 3, 14);
        var asOf = new DateOnly(2025, 3, 15); // one day past the 15-year mark

        Assert.False(DrbWindow.IsOpen(discharge, asOf));
    }

    [Fact]
    public void Deadline_LeapDayDischarge_ClampsToFeb28InNonLeapTargetYear()
    {
        // 2008-02-29 + 15y -> 2023 is not a leap year; DateOnly.AddYears clamps to Feb 28
        // (it does not throw). Pin this: a future "clarification" to new DateOnly(y+15, m, d)
        // would throw ArgumentOutOfRangeException at runtime for leap-day discharges.
        Assert.Equal(new DateOnly(2023, 2, 28), DrbWindow.Deadline(new DateOnly(2008, 2, 29)));
    }
}
