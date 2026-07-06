namespace ReCharacter.RulesEngine;

public sealed record BoardNames(string DrbName, string BcmrName);

public static class BoardDirectory
{
    public static BoardNames For(Branch branch) => branch switch
    {
        Branch.Army => new BoardNames("ADRB", "ABCMR"),
        Branch.Navy or Branch.MarineCorps => new BoardNames("NDRB", "BCNR"),
        Branch.AirForce or Branch.SpaceForce => new BoardNames("AFDRB", "AFBCMR"),
        Branch.CoastGuard => new BoardNames("CGDRB", "BCMR (DHS)"),
        _ => throw new ArgumentOutOfRangeException(nameof(branch), branch, "Unknown branch")
    };
}
