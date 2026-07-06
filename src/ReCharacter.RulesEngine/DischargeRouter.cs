namespace ReCharacter.RulesEngine;

public sealed class DischargeRouter(IClock clock)
{
    public RoutingResult Route(DischargeFacts facts)
    {
        if (facts.DischargeDate > clock.Today)
            throw new ArgumentException("Discharge date cannot be in the future.", nameof(facts));

        var names = BoardDirectory.For(facts.Branch);
        var deadline = DrbWindow.Deadline(facts.DischargeDate);
        var drbOpen = DrbWindow.IsOpen(facts.DischargeDate, clock.Today);
        var flags = new List<RoutingFlag>();

        // The DRB cannot review general-court-martial discharges; the BCMR must.
        var mustUseBcmr = facts.WasGeneralCourtMartial || !drbOpen;

        if (facts.WasGeneralCourtMartial)
            flags.Add(RoutingFlag.GeneralCourtMartialRequiresBcmr);
        else if (!drbOpen)
            flags.Add(RoutingFlag.PastDrbWindow);

        if (mustUseBcmr)
            flags.Add(RoutingFlag.BcmrThreeYearStatuteWaiverLikely);

        if (facts.Branch == Branch.CoastGuard)
            flags.Add(RoutingFlag.CoastGuardDhsPolicyDiffers);

        if (facts.Characterization == DischargeCharacterization.Uncharacterized)
            flags.Add(RoutingFlag.EntryLevelSeparationUncharacterized);

        if (facts.Characterization == DischargeCharacterization.Honorable)
            flags.Add(RoutingFlag.AlreadyHonorableNothingToUpgrade);

        var board = mustUseBcmr ? ReviewBoard.Bcmr : ReviewBoard.Drb;
        var form = board == ReviewBoard.Drb ? ApplicationForm.DD293 : ApplicationForm.DD149;
        var boardName = board == ReviewBoard.Drb ? names.DrbName : names.BcmrName;

        var available = new List<ReviewBoard>();
        if (drbOpen && !facts.WasGeneralCourtMartial)
            available.Add(ReviewBoard.Drb);
        available.Add(ReviewBoard.Bcmr);

        return new RoutingResult
        {
            RecommendedBoard = board,
            RecommendedForm = form,
            BoardName = boardName,
            AvailableBoards = available,
            DrbDeadline = deadline,
            DrbWindowOpen = drbOpen,
            Flags = flags
        };
    }
}
