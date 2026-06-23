import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MessageImageBanner } from "@/components/Reader";

describe("MessageImageBanner", () => {
  it("shows the blocked count and fires Display images", async () => {
    const onShow = vi.fn();
    render(<MessageImageBanner count={3} sender="a@b.com" onShow={onShow} onAlways={vi.fn()} />);
    expect(screen.getByText(/3 images blocked/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /display images/i }));
    await waitFor(() => expect(onShow).toHaveBeenCalled());
  });

  it("does not render when count is 0", () => {
    const { container } = render(<MessageImageBanner count={0} sender="a@b.com" onShow={vi.fn()} onAlways={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
