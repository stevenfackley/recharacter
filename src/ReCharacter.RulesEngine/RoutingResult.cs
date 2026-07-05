namespace ReCharacter.RulesEngine;

/// <summary>
/// The deterministic routing outcome for a discharge: which board and form to use, the DRB
/// filing deadline, board availability, and advisory flags. Serialized over HTTP by later plans;
/// collections are never null (empty when nothing applies).
/// </summary>
public sealed record RoutingResult
{
    public required ReviewBoard RecommendedBoard { get; init; }
    public required ApplicationForm RecommendedForm { get; init; }
    public required string BoardName { get; init; }
    public required IReadOnlyList<ReviewBoard> AvailableBoards { get; init; }

    /// <summary>
    /// The last day the DRB window is open: discharge date + 15 years (inclusive). Always
    /// populated — when <see cref="DrbWindowOpen"/> is false this is a past date indicating when
    /// the window closed. Consumers must gate on <see cref="DrbWindowOpen"/>, not on this date.
    /// </summary>
    public required DateOnly DrbDeadline { get; init; }

    public required bool DrbWindowOpen { get; init; }
    public required IReadOnlyList<RoutingFlag> Flags { get; init; }
}
