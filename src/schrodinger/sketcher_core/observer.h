#pragma once

#include <algorithm>
#include <cstddef>
#include <functional>
#include <utility>
#include <vector>

namespace schrodinger
{
namespace sketcher_core
{

/**
 * RAII handle representing one subscription to a Signal.
 * Disconnects on destruction or explicit disconnect(). Moveable, not copyable.
 *
 * The signal a Connection points to must outlive the Connection. (For the
 * Phase 0 spike: callers manage that lifetime manually.)
 */
class Connection
{
  public:
    Connection() = default;

    explicit Connection(std::function<void()> disconnect_fn) :
        m_disconnect(std::move(disconnect_fn))
    {
    }

    Connection(Connection&& other) noexcept :
        m_disconnect(std::move(other.m_disconnect))
    {
        other.m_disconnect = nullptr;
    }

    Connection& operator=(Connection&& other) noexcept
    {
        if (this != &other) {
            disconnect();
            m_disconnect = std::move(other.m_disconnect);
            other.m_disconnect = nullptr;
        }
        return *this;
    }

    Connection(const Connection&) = delete;
    Connection& operator=(const Connection&) = delete;

    ~Connection()
    {
        disconnect();
    }

    void disconnect()
    {
        if (m_disconnect) {
            m_disconnect();
            m_disconnect = nullptr;
        }
    }

  private:
    std::function<void()> m_disconnect;
};

/**
 * Tiny std::function-based signal — the Qt-free replacement for Q_SIGNALS.
 *
 * connect() returns a Connection that, when destroyed, removes the slot.
 * emit() invokes all currently-connected slots in subscription order.
 *
 * Not thread-safe and not reentrant-safe beyond what a single snapshot copy
 * gives you (slots may freely connect/disconnect during emission; the snapshot
 * just keeps the iteration stable for the current emit call).
 */
template <typename... Args> class Signal
{
  public:
    using Slot = std::function<void(Args...)>;

    Signal() = default;
    Signal(const Signal&) = delete;
    Signal& operator=(const Signal&) = delete;
    // Moving would invalidate Connection back-pointers — disallow.
    Signal(Signal&&) = delete;
    Signal& operator=(Signal&&) = delete;

    Connection connect(Slot slot)
    {
        const auto id = m_next_id++;
        m_subscribers.push_back({id, std::move(slot)});
        return Connection([this, id] { disconnect(id); });
    }

    void emit(Args... args) const
    {
        auto snapshot = m_subscribers;
        for (const auto& sub : snapshot) {
            sub.slot(args...);
        }
    }

    std::size_t slotCount() const
    {
        return m_subscribers.size();
    }

  private:
    struct Subscriber {
        std::size_t id;
        Slot slot;
    };

    void disconnect(std::size_t id)
    {
        m_subscribers.erase(
            std::remove_if(m_subscribers.begin(), m_subscribers.end(),
                           [id](const Subscriber& s) { return s.id == id; }),
            m_subscribers.end());
    }

    mutable std::vector<Subscriber> m_subscribers;
    std::size_t m_next_id = 0;
};

} // namespace sketcher_core
} // namespace schrodinger
