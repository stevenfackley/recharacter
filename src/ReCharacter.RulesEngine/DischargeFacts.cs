namespace ReCharacter.RulesEngine;

public sealed record DischargeFacts
{
    public required Branch Branch { get; init; }
    public required DateOnly DischargeDate { get; init; }
    public required DischargeCharacterization Characterization { get; init; }
    public bool WasGeneralCourtMartial { get; init; }
}
