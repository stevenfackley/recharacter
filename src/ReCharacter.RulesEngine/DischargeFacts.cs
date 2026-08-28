namespace ReCharacter.RulesEngine;

public sealed record DischargeFacts
{
    public required Branch Branch { get; init; }
    public required DateOnly DischargeDate { get; init; }
    public required DischargeCharacterization Characterization { get; init; }

    /// <summary>
    /// True if this discharge was adjudged by a general court-martial (as opposed to a special
    /// court-martial, or administratively). Defaults to false — treat an absent/unknown value as
    /// false, not as "not a GCM": <see cref="DischargeRouter"/> also independently infers GCM
    /// whenever <see cref="Characterization"/> is <see cref="DischargeCharacterization.DishonorableDischarge"/>,
    /// since only a general court-martial can adjudge a Dishonorable Discharge (UCMJ Art. 19)
    /// regardless of what this flag says.
    /// </summary>
    public bool WasGeneralCourtMartial { get; init; }
}
