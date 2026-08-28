using ReCharacter.RulesEngine;
using Xunit;

namespace ReCharacter.RulesEngine.Tests;

public class BoardDirectoryTests
{
    [Theory]
    [InlineData(Branch.Army, "ADRB", "ABCMR")]
    [InlineData(Branch.Navy, "NDRB", "BCNR")]
    [InlineData(Branch.MarineCorps, "NDRB", "BCNR")]
    [InlineData(Branch.AirForce, "AFDRB", "AFBCMR")]
    [InlineData(Branch.SpaceForce, "AFDRB", "AFBCMR")]
    [InlineData(Branch.CoastGuard, "CGDRB", "BCMR (DHS)")]
    public void For_ReturnsCorrectBoardNames(Branch branch, string drb, string bcmr)
    {
        var names = BoardDirectory.For(branch);

        Assert.Equal(drb, names.DrbName);
        Assert.Equal(bcmr, names.BcmrName);
    }

    [Fact]
    public void For_EveryDefinedBranch_DoesNotThrow()
    {
        // Guards against a new Branch enum member being added without a BoardDirectory mapping.
        foreach (var branch in Enum.GetValues<Branch>())
            BoardDirectory.For(branch);
    }
}
