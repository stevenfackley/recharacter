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

    [Fact]
    public void Route_DishonorableDischarge_FlagUnset_StillTreatedAsGcm_RoutesToBcmr()
    {
        // A DD can only be adjudged by a general court-martial (UCMJ Art. 19); the DRB (10 U.S.C.
        // §1553) cannot review any GCM discharge. This must hold even when the upstream flag is
        // unset (e.g. DD-214 extraction defaulted it to false) — the characterization alone implies GCM.
        var facts = new DischargeFacts
        {
            Branch = Branch.Army,
            DischargeDate = new DateOnly(2020, 1, 1), // within 15 years
            Characterization = DischargeCharacterization.DishonorableDischarge,
            WasGeneralCourtMartial = false
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(ReviewBoard.Bcmr, result.RecommendedBoard);
        Assert.Equal(ApplicationForm.DD149, result.RecommendedForm);
        Assert.Contains(RoutingFlag.GeneralCourtMartialRequiresBcmr, result.Flags);
        Assert.DoesNotContain(RoutingFlag.PastDrbWindow, result.Flags);
        Assert.Equal(new[] { ReviewBoard.Bcmr }, result.AvailableBoards);
        // The DRB window is technically still open — DD just isn't DRB-reviewable regardless.
        Assert.True(result.DrbWindowOpen);
    }

    [Fact]
    public void Route_DishonorableDischarge_FlagSet_SameResult_NoDuplicateFlags()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.Army,
            DischargeDate = new DateOnly(2020, 1, 1),
            Characterization = DischargeCharacterization.DishonorableDischarge,
            WasGeneralCourtMartial = true
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(ReviewBoard.Bcmr, result.RecommendedBoard);
        Assert.Equal(ApplicationForm.DD149, result.RecommendedForm);
        // Same flags as the flag-unset case above (plus the always-paired waiver-likely flag) —
        // no duplicate GeneralCourtMartialRequiresBcmr from the flag and the characterization both firing.
        Assert.Equal(
            new[] { RoutingFlag.GeneralCourtMartialRequiresBcmr, RoutingFlag.BcmrThreeYearStatuteWaiverLikely },
            result.Flags);
        Assert.Equal(new[] { ReviewBoard.Bcmr }, result.AvailableBoards);
    }

    [Fact]
    public void Route_BadConductDischarge_FlagUnset_WithinWindow_RemainsDrbReviewable()
    {
        // A special court-martial can adjudge a BCD (unlike a DD), so absent the GCM flag a BCD
        // stays DRB-reviewable — only the characterization-implies-GCM rule is DD-specific.
        var facts = new DischargeFacts
        {
            Branch = Branch.Navy,
            DischargeDate = new DateOnly(2020, 1, 1),
            Characterization = DischargeCharacterization.BadConductDischarge,
            WasGeneralCourtMartial = false
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(ReviewBoard.Drb, result.RecommendedBoard);
        Assert.Equal(ApplicationForm.DD293, result.RecommendedForm);
        Assert.Equal(new[] { ReviewBoard.Drb, ReviewBoard.Bcmr }, result.AvailableBoards);
    }

    [Fact]
    public void Route_BadConductDischarge_FlagSet_RoutesToBcmr()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.Navy,
            DischargeDate = new DateOnly(2020, 1, 1),
            Characterization = DischargeCharacterization.BadConductDischarge,
            WasGeneralCourtMartial = true
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(ReviewBoard.Bcmr, result.RecommendedBoard);
        Assert.DoesNotContain(ReviewBoard.Drb, result.AvailableBoards);
    }

    [Fact]
    public void Route_SpaceForce_WithinWindow_UsesAfdrbBoardName()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.SpaceForce,
            DischargeDate = new DateOnly(2024, 6, 1),
            Characterization = DischargeCharacterization.OtherThanHonorable,
            WasGeneralCourtMartial = false
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal("AFDRB", result.BoardName);
        Assert.Equal(ReviewBoard.Drb, result.RecommendedBoard);
    }

    [Fact]
    public void Route_DischargeDateEqualsToday_DoesNotThrow_DrbOpen()
    {
        var facts = new DischargeFacts
        {
            Branch = Branch.Army,
            DischargeDate = new DateOnly(2026, 7, 5),
            Characterization = DischargeCharacterization.OtherThanHonorable,
            WasGeneralCourtMartial = false
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.True(result.DrbWindowOpen);
    }

    [Theory]
    [InlineData(2024, 6, 1, false, new[] { ReviewBoard.Drb, ReviewBoard.Bcmr })] // in window, not GCM
    [InlineData(2009, 1, 1, false, new[] { ReviewBoard.Bcmr })]                  // past window
    [InlineData(2024, 6, 1, true, new[] { ReviewBoard.Bcmr })]                   // GCM, window still open
    [InlineData(2009, 1, 1, true, new[] { ReviewBoard.Bcmr })]                   // GCM and past window
    public void Route_AvailableBoards_ListsDrbOnlyWhenWindowOpenAndNotCourtMartial(
        int year, int month, int day, bool wasGeneralCourtMartial, ReviewBoard[] expected)
    {
        // Pins the exact composition and order. A BCD can come from either a special court-martial
        // (DRB-reviewable) or a general court-martial (BCMR only), so the flag alone drives the
        // difference between rows with the same date. BCMR is always listed, last.
        var facts = new DischargeFacts
        {
            Branch = Branch.Navy,
            DischargeDate = new DateOnly(year, month, day),
            Characterization = DischargeCharacterization.BadConductDischarge,
            WasGeneralCourtMartial = wasGeneralCourtMartial
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(expected, result.AvailableBoards);
    }

    [Fact]
    public void Route_GeneralUnderHonorable_WithinWindow_RecommendsDrbWithNoFlags()
    {
        // General (Under Honorable Conditions) is the most common upgrade candidate and has no
        // special case of its own: unlike Honorable there is something to upgrade, and unlike
        // Uncharacterized there is no entry-level caveat. It routes exactly like an OTH.
        var facts = new DischargeFacts
        {
            Branch = Branch.Army,
            DischargeDate = new DateOnly(2024, 6, 1),
            Characterization = DischargeCharacterization.GeneralUnderHonorable,
            WasGeneralCourtMartial = false
        };

        var result = RouterAt(2026, 7, 5).Route(facts);

        Assert.Equal(ReviewBoard.Drb, result.RecommendedBoard);
        Assert.Equal(ApplicationForm.DD293, result.RecommendedForm);
        Assert.Equal("ADRB", result.BoardName);
        Assert.True(result.DrbWindowOpen);
        Assert.Equal(new DateOnly(2039, 6, 1), result.DrbDeadline);
        Assert.Equal(new[] { ReviewBoard.Drb, ReviewBoard.Bcmr }, result.AvailableBoards);
        Assert.Empty(result.Flags);
    }

    [Theory]
    [InlineData(2024, 6, 1)]  // in window
    [InlineData(2009, 1, 1)]  // past window: the deadline is still populated, as a past date
    [InlineData(2008, 2, 29)] // leap-day discharge: inherits DrbWindow's Feb-28 clamp
    public void Route_DrbDeadline_EqualsDrbWindowDeadlineForDischargeDate(int year, int month, int day)
    {
        // The router must delegate to DrbWindow rather than carry its own copy of the 15-year math.
        var asOf = new DateOnly(2026, 7, 5);
        var dischargeDate = new DateOnly(year, month, day);
        var facts = new DischargeFacts
        {
            Branch = Branch.Army,
            DischargeDate = dischargeDate,
            Characterization = DischargeCharacterization.OtherThanHonorable
        };

        var result = new DischargeRouter(new FakeClock(asOf)).Route(facts);

        Assert.Equal(DrbWindow.Deadline(dischargeDate), result.DrbDeadline);
        Assert.Equal(DrbWindow.IsOpen(dischargeDate, asOf), result.DrbWindowOpen);
    }

    [Theory]
    [InlineData(Branch.Army, "ADRB", "ABCMR")]
    [InlineData(Branch.Navy, "NDRB", "BCNR")]
    [InlineData(Branch.MarineCorps, "NDRB", "BCNR")]
    [InlineData(Branch.AirForce, "AFDRB", "AFBCMR")]
    [InlineData(Branch.SpaceForce, "AFDRB", "AFBCMR")]
    [InlineData(Branch.CoastGuard, "CGDRB", "BCMR (DHS)")]
    public void Route_EveryBranch_UsesBoardDirectoryNameForTheRecommendedBoard(
        Branch branch, string drbName, string bcmrName)
    {
        var router = RouterAt(2026, 7, 5);

        var inWindow = router.Route(new DischargeFacts
        {
            Branch = branch,
            DischargeDate = new DateOnly(2024, 6, 1),
            Characterization = DischargeCharacterization.OtherThanHonorable
        });
        var pastWindow = router.Route(new DischargeFacts
        {
            Branch = branch,
            DischargeDate = new DateOnly(2009, 1, 1),
            Characterization = DischargeCharacterization.OtherThanHonorable
        });

        Assert.Equal(drbName, inWindow.BoardName);
        Assert.Equal(bcmrName, pastWindow.BoardName);
    }
}
