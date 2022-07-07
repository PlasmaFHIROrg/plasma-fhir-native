import { useState, useCallback } from "react";
import { View, Text, TextInput, StyleSheet } from "react-native";
import { Range } from "fhir/r4";
import { Resources } from "plasma-fhir-app-utils";

// TODO: Extend this so we can pass in all the other input props
// TODO: Make other components use the "plasma-fhir-app-utils" library for formatting and stuff

export interface IRangeInputProps { 
    placeholder?: string;

    value?: Range | undefined;
    onChange?: (text: string, value: Range | undefined) => void;
}

const RangeInput: React.FC<IRangeInputProps> = (props: IRangeInputProps) => {
    const [rangeValue, setRangeValue] = useState<Resources.Range | undefined>(props.value);
    const [rangeText, setRangeText] = useState<string>((props.value) ? Resources.Range.toString(props.value) : "");

    const onChange = useCallback((s: string) => {
        // Try to parse the range. If we can, then update the value and reformat.
        // If we can't, erase the value and leave the format as-is.
        const range = Resources.Range.fromString(s);   // Can be undefined
        const text = (range) ? Resources.Range.toString(range) : s;

        // Update state...
        setRangeValue(range);
        setRangeText(text);

        // Call client onChange...
        if (props.onChange) { props.onChange(text, range); }

    }, [props.onChange, setRangeValue, setRangeText])

    return (
        <TextInput style={styles.RangeInput}
            placeholder={props.placeholder ?? ""} 
            value={rangeText}
            onChangeText={onChange}
        />
    );
}

const styles = StyleSheet.create({
    RangeInput: { }
});

export default RangeInput;