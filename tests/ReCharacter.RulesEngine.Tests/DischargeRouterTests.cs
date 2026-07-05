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
}
