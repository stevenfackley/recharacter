using ReCharacter.RulesEngine;
using Xunit;

namespace ReCharacter.RulesEngine.Tests;

public class DischargeRouterTests
{
    private static DischargeRouter RouterAt(int year, int month, int day) =>
        new(new FakeClock(new DateOnly(year, month, day)));

    [Fact]
    public void Route_MarineOthAdminSep_WithinWindow_RecommendsDrbWithDd293()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.MarineCorps,
            DischargeDate = new DateOnly(2024, 6, 1),
            Characterization = DischargeCharacterization.OtherThanHonorable,
            WasGeneralCourtMartial = false
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(ReviewBoard.Drb, result.RecommendedBoard);
        Assert.Equal(ApplicationForm.DD293, result.RecommendedForm);
        Assert.Equal("NDRB", result.BoardName);
        Assert.True(result.DrbWindowOpen);
        Assert.Equal(new DateOnly(2039, 6, 1), result.DrbDeadline);
        Assert.Equal(new[] { ReviewBoard.Drb, ReviewBoard.Bcmr }, result.AvailableBoards);
        Assert.Empty(result.Flags);
    }

    [Fact]
    public void Route_MarineOth_PastFifteenYears_RecommendsBcmrWithDd149()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.MarineCorps,
            DischargeDate = new DateOnly(2009, 1, 1),
            Characterization = DischargeCharacterization.OtherThanHonorable,
            WasGeneralCourtMartial = false
        };

        var result = RouterAt(2026, 7, 5).Route(facts); // > 15 years later

        Assert.Equal(ReviewBoard.Bcmr, result.RecommendedBoard);
        Assert.Equal(ApplicationForm.DD149, result.RecommendedForm);
        Assert.Equal("BCNR", result.BoardName);
        Assert.False(result.DrbWindowOpen);
        Assert.Equal(new[] { ReviewBoard.Bcmr }, result.AvailableBoards);
        Assert.Contains(RoutingFlag.PastDrbWindow, result.Flags);
        Assert.Contains(RoutingFlag.BcmrThreeYearStatuteWaiverLikely, result.Flags);
    }

    [Fact]
    public void Route_GeneralCourtMartial_WithinWindow_StillRoutesToBcmr()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.Army,
            DischargeDate = new DateOnly(2023, 5, 1), // well within 15 years
            Characterization = DischargeCharacterization.BadConductDischarge,
            WasGeneralCourtMartial = true
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(ReviewBoard.Bcmr, result.RecommendedBoard);
        Assert.Equal(ApplicationForm.DD149, result.RecommendedForm);
        Assert.Equal("ABCMR", result.BoardName);
        Assert.Contains(RoutingFlag.GeneralCourtMartialRequiresBcmr, result.Flags);
        Assert.DoesNotContain(ReviewBoard.Drb, result.AvailableBoards);
        // DRB window is technically open, even though DRB is unavailable for GCM.
        Assert.True(result.DrbWindowOpen);
    }

    [Fact]
    public void Route_CoastGuard_AddsDhsPolicyFlag()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.CoastGuard,
            DischargeDate = new DateOnly(2022, 2, 2),
            Characterization = DischargeCharacterization.GeneralUnderHonorable
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal("CGDRB", result.BoardName);
        Assert.Contains(RoutingFlag.CoastGuardDhsPolicyDiffers, result.Flags);
    }

    [Fact]
    public void Route_Uncharacterized_AddsEntryLevelFlag()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.Navy,
            DischargeDate = new DateOnly(2023, 9, 9),
            Characterization = DischargeCharacterization.Uncharacterized
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Contains(RoutingFlag.EntryLevelSeparationUncharacterized, result.Flags);
    }

    [Fact]
    public void Route_AlreadyHonorable_AddsNothingToUpgradeFlag()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.AirForce,
            DischargeDate = new DateOnly(2023, 9, 9),
            Characterization = DischargeCharacterization.Honorable
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Contains(RoutingFlag.AlreadyHonorableNothingToUpgrade, result.Flags);
    }

    [Fact]
    public void Route_FutureDischargeDate_Throws()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.Army,
            DischargeDate = new DateOnly(2027, 1, 1),
            Characterization = DischargeCharacterization.OtherThanHonorable
        };

        Assert.Throws<ArgumentException>(() => RouterAt(2026, 7, 5).Route(facts));
    }

    [Fact]
    public void Route_MultipleConditions_EmitsExactlyTheExpectedFlags_NoExtrasOrDuplicates()
    {
        // Coast Guard + past-window + uncharacterized should yield exactly four flags, in order,
        // with no duplicates or spurious extras. The per-flag Assert.Contains tests elsewhere
        // would not catch over-emission; this pins the full output.
        var facts = new DischargeFacts
        {
            Branch = Branch.CoastGuard,
            DischargeDate = new DateOnly(2005, 1, 1), // > 15 years before as-of
            Characterization = DischargeCharacterization.Uncharacterized,
            WasGeneralCourtMartial = false
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(
            new[]
            {
                RoutingFlag.PastDrbWindow,
                RoutingFlag.BcmrThreeYearStatuteWaiverLikely,
                RoutingFlag.CoastGuardDhsPolicyDiffers,
                RoutingFlag.EntryLevelSeparationUncharacterized
            },
            result.Flags);
        Assert.Equal(new[] { ReviewBoard.Bcmr }, result.AvailableBoards);
    }

    [Fact]
    public void Route_GeneralCourtMartial_AndPastWindow_FlagsGcmButNotPastWindow()
    {
        // Both conditions independently bar the DRB. The router reports the court-martial reason
        // and deliberately does NOT also emit PastDrbWindow (mutually exclusive by design).
        // Pin the intent so an else-if -> if refactor can't change the output silently.
        var facts = new DischargeFacts
        {
            Branch = Branch.Army,
            DischargeDate = new DateOnly(2005, 1, 1), // past 15 years
            Characterization = DischargeCharacterization.BadConductDischarge,
            WasGeneralCourtMartial = true
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(ReviewBoard.Bcmr, result.RecommendedBoard);
        Assert.Contains(RoutingFlag.GeneralCourtMartialRequiresBcmr, result.Flags);
        Assert.DoesNotContain(RoutingFlag.PastDrbWindow, result.Flags);
        Assert.False(result.DrbWindowOpen);
    }
}
