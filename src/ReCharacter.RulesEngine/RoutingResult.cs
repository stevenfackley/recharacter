namespace ReCharacter.RulesEngine;

public sealed record RoutingResult
{
    public required ReviewBoard RecommendedBoard { get; init; }
    public required ApplicationForm RecommendedForm { get; init; }
    public required string BoardName { get; init; }
    public required IReadOnlyList<ReviewBoard> AvailableBoards { get; init; }
    public required DateOnly DrbDeadline { get; init; }
    public required bool DrbWindowOpen { get; init; }
    public required IReadOnlyList<RoutingFlag> Flags { get; init; }
}
