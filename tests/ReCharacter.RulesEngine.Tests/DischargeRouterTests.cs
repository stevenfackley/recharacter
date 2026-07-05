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
}
