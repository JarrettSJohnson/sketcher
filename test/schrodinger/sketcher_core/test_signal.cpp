/* -------------------------------------------------------------------------
 * Tests for schrodinger::sketcher_core::Signal — the Qt-free Q_SIGNALS
 * replacement used by the Phase 0 spike.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#define BOOST_TEST_MODULE sketcher_core_signal

#include <string>
#include <vector>

#include <boost/test/unit_test.hpp>

#include "schrodinger/sketcher_core/observer.h"

using schrodinger::sketcher_core::Connection;
using schrodinger::sketcher_core::Signal;

BOOST_AUTO_TEST_CASE(testEmitInvokesConnectedSlots)
{
    Signal<int> sig;
    int seen = 0;
    auto c = sig.connect([&](int v) { seen = v; });

    sig.emit(42);

    BOOST_CHECK_EQUAL(seen, 42);
    BOOST_CHECK_EQUAL(sig.slotCount(), 1u);
}

BOOST_AUTO_TEST_CASE(testMultipleSubscribersFireInOrder)
{
    Signal<int> sig;
    std::vector<int> received;
    auto c1 = sig.connect([&](int v) { received.push_back(v); });
    auto c2 = sig.connect([&](int v) { received.push_back(v * 10); });
    auto c3 = sig.connect([&](int v) { received.push_back(v * 100); });

    sig.emit(2);

    BOOST_REQUIRE_EQUAL(received.size(), 3u);
    BOOST_CHECK_EQUAL(received[0], 2);
    BOOST_CHECK_EQUAL(received[1], 20);
    BOOST_CHECK_EQUAL(received[2], 200);
}

BOOST_AUTO_TEST_CASE(testDestroyingConnectionStopsDelivery)
{
    Signal<int> sig;
    int count = 0;
    {
        auto c = sig.connect([&](int) { ++count; });
        sig.emit(0);
        BOOST_CHECK_EQUAL(count, 1);
    }
    sig.emit(0);
    BOOST_CHECK_EQUAL(count, 1);
    BOOST_CHECK_EQUAL(sig.slotCount(), 0u);
}

BOOST_AUTO_TEST_CASE(testExplicitDisconnectIsIdempotent)
{
    Signal<int> sig;
    int count = 0;
    auto c = sig.connect([&](int) { ++count; });

    c.disconnect();
    c.disconnect(); // second call is a no-op

    sig.emit(0);
    BOOST_CHECK_EQUAL(count, 0);
    BOOST_CHECK_EQUAL(sig.slotCount(), 0u);
}

BOOST_AUTO_TEST_CASE(testMovingConnectionTransfersOwnership)
{
    Signal<int> sig;
    int count = 0;
    auto c1 = sig.connect([&](int) { ++count; });

    Connection c2 = std::move(c1);
    sig.emit(0);
    BOOST_CHECK_EQUAL(count, 1);

    c2.disconnect();
    sig.emit(0);
    BOOST_CHECK_EQUAL(count, 1);
}

BOOST_AUTO_TEST_CASE(testMultipleArgumentsAndVoidSignal)
{
    Signal<int, std::string> with_args;
    std::string captured;
    auto c1 = with_args.connect(
        [&](int n, std::string s) { captured = s + ":" + std::to_string(n); });
    with_args.emit(7, "x");
    BOOST_CHECK_EQUAL(captured, "x:7");

    Signal<> void_sig;
    int hit = 0;
    auto c2 = void_sig.connect([&] { ++hit; });
    void_sig.emit();
    void_sig.emit();
    BOOST_CHECK_EQUAL(hit, 2);
}

BOOST_AUTO_TEST_CASE(testSnapshotProtectsAgainstMutationDuringEmit)
{
    // A slot disconnecting another slot mid-emit must not invalidate the
    // current iteration. The Signal makes a snapshot copy before iterating.
    Signal<int> sig;
    int late_hits = 0;
    Connection late;
    auto early = sig.connect([&](int) {
        late.disconnect(); // pull the rug
    });
    late = sig.connect([&](int) { ++late_hits; });

    sig.emit(1);
    // Both slots fire this round (late's removal isn't visible until next
    // emit).
    BOOST_CHECK_EQUAL(late_hits, 1);

    sig.emit(1);
    BOOST_CHECK_EQUAL(late_hits, 1);
}
